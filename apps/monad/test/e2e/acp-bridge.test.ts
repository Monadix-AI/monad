// Drives monad's ACP agent backed by the BRIDGE handlers (transports/acp/bridge.ts) instead of
// in-process handlers: the bridge proxies every call to a real daemon HTTP app mounted on a Unix
// socket. This is the shared-daemon path `monad acp` takes — REST for control + inline SSE for a
// turn — all in one process (the daemon app + bridge + ACP client), so there's no second `bun`.

import type { RequestPermissionResponse, SessionNotification, Stream } from '@agentclientprotocol/sdk';
import type { ModelMessage, ModelResult, ModelRouter } from '@/agent/index.ts';
import type { Tool } from '@/capabilities/tools/types.ts';

import { expect, test } from 'bun:test';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { client as acpClient, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

import { fsReadTool, fsWriteTool } from '@/capabilities/tools';
import { createBridgeHandlers } from '@/transports/acp/bridge.ts';
import { connectAcp } from '@/transports/acp/connection.ts';
import { createHttpTransport } from '@/transports/http.ts';
import { buildHandlers, mockModel } from '../helpers.ts';

type Step = string | { tool: string; input?: unknown };

/** Drives the streaming tool loop: each stream() call yields one scripted step. */
function scriptedModel(steps: Step[]): ModelRouter {
  let i = 0;
  return {
    async *stream() {
      const step: Step = steps[i] ?? 'done';
      i++;
      if (typeof step === 'string') yield { type: 'text' as const, token: step };
      else
        yield {
          type: 'tool-call' as const,
          call: { toolCallId: `tc_${i}`, toolName: step.tool, input: step.input ?? {} }
        };
    },
    async complete(): Promise<ModelResult> {
      return { text: 'done', finishReason: 'stop' };
    }
  };
}

function pipe(): { agent: Stream; clientStream: Stream } {
  const c2a = new TransformStream<Uint8Array, Uint8Array>();
  const a2c = new TransformStream<Uint8Array, Uint8Array>();
  return {
    agent: ndJsonStream(a2c.writable, c2a.readable),
    clientStream: ndJsonStream(c2a.writable, a2c.readable)
  };
}

function makeClientApp(updates: SessionNotification[], permissionChoice = 'allow') {
  return acpClient()
    .onNotification('session/update', ({ params }) => {
      updates.push(params);
    })
    .onRequest(
      'session/request_permission',
      (): RequestPermissionResponse => ({
        outcome: { outcome: 'selected', optionId: permissionChoice }
      })
    );
}

/** Mount the daemon HTTP app on a fresh Unix socket and hand back the bridge handlers + teardown. */
function bridgeToDaemon(model: ModelRouter = mockModel(), opts?: { tools?: Tool[] }) {
  const daemon = createHttpTransport(buildHandlers(model, undefined, opts));
  // Keep the path short — macOS caps unix socket paths around 104 bytes.
  const sock = join(tmpdir(), `monad-acpb-${process.pid}-${Date.now()}.sock`);
  const server = Bun.serve({ unix: sock, fetch: (req) => daemon.handle(req) }) as unknown as {
    stop: (force?: boolean) => void;
  };
  const { handlers } = createBridgeHandlers({ baseUrl: 'http://localhost', unixSocket: sock });
  return {
    handlers,
    stop: async () => {
      server.stop(true);
      await unlink(sock).catch(() => {});
    }
  };
}

test('bridge: initialize → newSession → prompt streams chunks over the socket and ends the turn', async () => {
  const daemon = bridgeToDaemon();
  const { agent, clientStream } = pipe();
  connectAcp(daemon.handlers, agent);
  const updates: SessionNotification[] = [];

  try {
    await makeClientApp(updates).connectWith(clientStream, async (ctx) => {
      const init = await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      expect(init.agentInfo?.name).toBe('monad');

      const { sessionId } = await ctx.request('session/new', { cwd: '/tmp', mcpServers: [] });
      expect(sessionId).toBeTruthy();

      const res = await ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
      expect(res.stopReason).toBe('end_turn');

      // The streamed chunks arrived over the daemon's inline-SSE response, proxied by the bridge.
      const chunks = updates
        .filter((u) => u.update.sessionUpdate === 'agent_message_chunk')
        .map((u) => (u.update as { content: { text: string } }).content.text)
        .join('');
      expect(chunks).toBe('Hello from the mock model.');
    });
  } finally {
    await daemon.stop();
  }
});

test('bridge: fork maps to a daemon branch and the session is visible via the shared daemon', async () => {
  const daemon = bridgeToDaemon();
  const { agent, clientStream } = pipe();
  connectAcp(daemon.handlers, agent);

  try {
    await makeClientApp([]).connectWith(clientStream, async (ctx) => {
      await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const { sessionId } = await ctx.request('session/new', { cwd: '/tmp', mcpServers: [] });

      const forked = await ctx.request('session/fork', { sessionId, cwd: '/tmp', mcpServers: [] });
      expect(forked.sessionId).toBeTruthy();
      expect(forked.sessionId).not.toBe(sessionId);

      // list() proxies to GET /sessions on the daemon — both the original and the fork are there.
      const list = await ctx.request('session/list', {});
      const ids = list.sessions.map((s) => s.sessionId);
      expect(ids).toContain(sessionId);
      expect(ids).toContain(forked.sessionId);
    });
  } finally {
    await daemon.stop();
  }
});

test('bridge: a session is sandboxed to the editor cwd via configureRuntime → daemon registry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monad-acpb-cwd-'));
  try {
    await writeFile(join(dir, 'inside.txt'), 'inside-content');
    // Reads a file inside cwd (allowed) then one outside (rejected by the session sandbox).
    const daemon = bridgeToDaemon(
      scriptedModel([
        { tool: 'fs_read', input: { path: join(dir, 'inside.txt') } },
        { tool: 'fs_read', input: { path: '/etc/hosts' } },
        'done'
      ]),
      { tools: [fsReadTool as Tool] }
    );
    const { agent, clientStream } = pipe();
    connectAcp(daemon.handlers, agent);
    const updates: SessionNotification[] = [];

    try {
      // Non-delegated (no fs capability) → daemon's sandbox backend runs, scoped to the cwd that
      // newSession pushed to the daemon via configureRuntime.
      // Editor declines the out-of-cwd path-expansion prompt, so the read stays sandbox-rejected.
      await makeClientApp(updates, 'reject').connectWith(clientStream, async (ctx) => {
        await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
        const { sessionId } = await ctx.request('session/new', { cwd: dir, mcpServers: [] });
        await ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'read both' }] });

        const completed = updates.filter(
          (u) => u.update.sessionUpdate === 'tool_call_update' && u.update.status === 'completed'
        );
        const failed = updates.filter(
          (u) => u.update.sessionUpdate === 'tool_call_update' && u.update.status === 'failed'
        );
        const okText = completed
          .flatMap((u) => (u.update as { content?: Array<{ content?: { text?: string } }> }).content ?? [])
          .map((c) => c.content?.text ?? '')
          .join('');
        expect(okText).toContain('inside-content'); // in-cwd read succeeded
        expect(failed.length).toBeGreaterThan(0); // out-of-cwd read was sandbox-rejected
      });
    } finally {
      await daemon.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bridge: open-document ambient context reaches the model over the wire', async () => {
  let captured: ModelMessage[] | undefined;
  const capturing: ModelRouter = {
    async *stream(req) {
      captured = req.messages;
      yield { type: 'text' as const, token: 'ok' };
    },
    async complete(): Promise<ModelResult> {
      return { text: 'ok', finishReason: 'stop' };
    }
  };
  const daemon = bridgeToDaemon(capturing);
  const { agent, clientStream } = pipe();
  connectAcp(daemon.handlers, agent);

  try {
    await makeClientApp([]).connectWith(clientStream, async (ctx) => {
      await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const { sessionId } = await ctx.request('session/new', { cwd: '/proj', mcpServers: [] });
      await ctx.notify('document/didOpen', {
        sessionId,
        uri: 'file:///proj/a.ts',
        languageId: 'typescript',
        text: 'const answer = 42;',
        version: 1
      });
      await ctx.notify('document/didFocus', {
        sessionId,
        uri: 'file:///proj/a.ts',
        version: 1,
        position: { line: 0, character: 0 },
        visibleRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 18 } }
      });
      await ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'what is answer?' }] });

      // The bridge forwarded the rendered open-docs as `ambientContext` in the message POST body;
      // the daemon folded it into the last user message.
      const lastUser = [...(captured ?? [])].reverse().find((m) => m.role === 'user');
      const parts = (Array.isArray(lastUser?.content) ? lastUser?.content : []) as Array<{
        type: string;
        text?: string;
      }>;
      const ambient = parts.map((p) => p.text ?? '').join('\n');
      expect(ambient).toContain('file:///proj/a.ts');
      expect(ambient).toContain('const answer = 42;');
    });
  } finally {
    await daemon.stop();
  }
});

test('bridge: a session-scoped MCP server connects daemon-side and its tool runs in a turn', async () => {
  const fixture = resolve(import.meta.dir, '../unit/tools/fixtures/mock-mcp-server.ts');
  // The model calls the namespaced MCP tool (server "mock" → tool "echo"), then finishes.
  const daemon = bridgeToDaemon(scriptedModel([{ tool: 'mock__echo', input: { text: 'hi-from-mcp' } }, 'done']));
  const { agent, clientStream } = pipe();
  connectAcp(daemon.handlers, agent);
  const updates: SessionNotification[] = [];

  try {
    await makeClientApp(updates).connectWith(clientStream, async (ctx) => {
      await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      // newSession ships the MCP spec to the daemon via configureRuntime, which connects it there.
      const { sessionId } = await ctx.request('session/new', {
        cwd: '/tmp',
        mcpServers: [{ name: 'mock', command: 'bun', args: [fixture], env: [] }]
      });
      await ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'echo it' }] });

      const completedText = updates
        .filter((u) => u.update.sessionUpdate === 'tool_call_update' && u.update.status === 'completed')
        .flatMap((u) => (u.update as { content?: Array<{ content?: { text?: string } }> }).content ?? [])
        .map((c) => c.content?.text ?? '')
        .join('');
      expect(completedText).toContain('hi-from-mcp'); // the daemon-connected MCP tool ran in the turn
    });
  } finally {
    await daemon.stop();
  }
});

test('bridge: a delegated session routes fs_write back to the editor via the daemon DelegationService', async () => {
  const writes: { path: string; content: string }[] = [];
  // fs_write runs in the DAEMON loop, but the session is delegated → the daemon's remote backend emits
  // a delegation.fs_request, the bridge services it against the editor (this client), and answers via
  // delegation.respond. The write must land in the editor, NOT on the daemon disk.
  const daemon = bridgeToDaemon(
    scriptedModel([{ tool: 'fs_write', input: { path: '/proj/x.ts', content: 'hi' } }, 'done']),
    { tools: [fsWriteTool as Tool] }
  );
  const { agent, clientStream } = pipe();
  connectAcp(daemon.handlers, agent);

  try {
    await acpClient()
      .onNotification('session/update', () => {})
      .onRequest(
        'session/request_permission',
        (): RequestPermissionResponse => ({
          outcome: { outcome: 'selected', optionId: 'allow' }
        })
      )
      .onRequest('fs/write_text_file', async ({ params }) => {
        writes.push({ path: params.path, content: params.content });
        return {};
      })
      .onRequest('fs/read_text_file', () => ({ content: '' }))
      .connectWith(clientStream, async (ctx) => {
        await ctx.request('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }
        });
        const { sessionId } = await ctx.request('session/new', { cwd: '/proj', mcpServers: [] });
        await ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'write the file' }] });

        expect(writes).toEqual([{ path: '/proj/x.ts', content: 'hi' }]);
      });
  } finally {
    await daemon.stop();
  }
});

test('bridge: session/delete removes the session from the daemon', async () => {
  const daemon = bridgeToDaemon();
  const { agent, clientStream } = pipe();
  connectAcp(daemon.handlers, agent);

  try {
    await makeClientApp([]).connectWith(clientStream, async (ctx) => {
      await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const { sessionId } = await ctx.request('session/new', { cwd: '/tmp', mcpServers: [] });
      expect((await ctx.request('session/list', {})).sessions.some((s) => s.sessionId === sessionId)).toBe(true);
      await ctx.request('session/delete', { sessionId });
      expect((await ctx.request('session/list', {})).sessions.some((s) => s.sessionId === sessionId)).toBe(false);
    });
  } finally {
    await daemon.stop();
  }
});
