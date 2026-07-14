// Drives monad's ACP agent through the SDK's real client() API over an in-memory
// duplex pipe — the same wire path Zed would use, minus stdio framing.

import type { RequestPermissionResponse, SessionNotification, Stream } from '@agentclientprotocol/sdk';
import type { ModelMessage, ModelResult, ModelRouter } from '#/agent/index.ts';
import type { Tool } from '#/capabilities/tools/types.ts';

import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { client as acpClient, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

import { fileReadTool, fileWriteTool } from '#/capabilities/tools';
import { toolResult } from '#/capabilities/tools/types.ts';
import { connectAcp } from '#/transports/acp/connection.ts';
import { buildHandlers, mockModel } from '../helpers.ts';

type Step = string | { tool: string; input?: unknown };

/** A model that drives the streaming tool loop: each `stream()` call yields one scripted step —
 * a tool-call chunk, or a text token (the final answer). */
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

/** Two ndJson streams wired back-to-back to form a bidirectional in-memory pipe. */
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

test('initialize → newSession → prompt streams chunks and ends the turn', async () => {
  const { agent, clientStream } = pipe();
  connectAcp(buildHandlers(mockModel()), agent);
  const updates: SessionNotification[] = [];

  await makeClientApp(updates).connectWith(clientStream, async (ctx) => {
    const init = await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(init.agentInfo?.name).toBe('monad');

    const { sessionId } = await ctx.request('session/new', { cwd: '/tmp', mcpServers: [] });
    expect(sessionId).toMatch(/^ses_/);

    const res = await ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
    expect(res.stopReason).toBe('end_turn');

    const chunks = updates
      .filter((u) => u.update.sessionUpdate === 'agent_message_chunk')
      .map((u) => (u.update as { content: { text: string } }).content.text)
      .join('');
    expect(chunks).toBe('Hello from the mock model.');
  });
});

test('initialize advertises fork capability and monad extension methods', async () => {
  const { agent, clientStream } = pipe();
  connectAcp(buildHandlers(mockModel()), agent);

  await makeClientApp([]).connectWith(clientStream, async (ctx) => {
    const init = await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    expect(init.agentCapabilities?.sessionCapabilities?.fork).toEqual({});
    const ext = (init.agentCapabilities?._meta as { monad?: { extMethods?: string[] } } | undefined)?.monad?.extMethods;
    expect(ext).toContain('_monad/session.provenance');
    expect(ext).toContain('_monad/model.listProfiles');
  });
});

test('session/fork maps to monad branch and returns a new session id', async () => {
  const { agent, clientStream } = pipe();
  connectAcp(buildHandlers(mockModel()), agent);

  await makeClientApp([]).connectWith(clientStream, async (ctx) => {
    await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await ctx.request('session/new', { cwd: '/tmp', mcpServers: [] });
    const forked = await ctx.request('session/fork', { sessionId, cwd: '/tmp', mcpServers: [] });
    expect(forked.sessionId).toMatch(/^ses_/);
    expect(forked.sessionId).not.toBe(sessionId);
  });
});

test('newSession surfaces monad agentIds in _meta', async () => {
  const { agent, clientStream } = pipe();
  connectAcp(buildHandlers(mockModel()), agent);

  await makeClientApp([]).connectWith(clientStream, async (ctx) => {
    await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const res = await ctx.request('session/new', { cwd: '/tmp', mcpServers: [] });
    const agentIds = (res._meta as { monad?: { agentIds?: unknown } } | undefined)?.monad?.agentIds;
    expect(Array.isArray(agentIds)).toBe(true);
  });
});

test('_monad extension methods route to monad handlers', async () => {
  const { agent, clientStream } = pipe();
  connectAcp(buildHandlers(mockModel()), agent);

  await makeClientApp([]).connectWith(clientStream, async (ctx) => {
    await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await ctx.request('session/new', { cwd: '/tmp', mcpServers: [] });

    const prov = await ctx.request('_monad/session.provenance', { sessionId });
    expect((prov as { self: { id: string } }).self).toMatchObject({ id: sessionId });
    expect(Array.isArray((prov as { ancestors: unknown[] }).ancestors)).toBe(true);

    // model.* dispatch is covered by typecheck + the dispatcher; calling it needs a real config
    // (the test stub uses /dev/null), so we only assert unknown methods reject here.
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(ctx.request('_monad/unknown.method', {})).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

test('session/list returns sessions and session/load replays the transcript', async () => {
  const { agent, clientStream } = pipe();
  connectAcp(buildHandlers(mockModel()), agent);
  const updates: SessionNotification[] = [];

  await makeClientApp(updates).connectWith(clientStream, async (ctx) => {
    await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });

    const { sessionId } = await ctx.request('session/new', { cwd: '/tmp', mcpServers: [] });
    await ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi there' }] });

    const list = await ctx.request('session/list', {});
    expect(list.sessions.some((s) => s.sessionId === sessionId)).toBe(true);

    // Load replays the persisted user + assistant messages as chunks on the same connection.
    updates.length = 0;
    await ctx.request('session/load', { sessionId, cwd: '/tmp', mcpServers: [] });
    const texts = updates
      .filter((u) => u.update.sessionUpdate.endsWith('message_chunk'))
      .map((u) => (u.update as { content: { text: string } }).content.text);
    expect(texts).toContain('hi there');
    expect(texts.join('')).toContain('Hello from the mock model.');
  });
});

test('a model error ends the turn as an error, not a silent end_turn', async () => {
  const failing: ModelRouter = {
    // biome-ignore lint/correctness/useYield: error thrown on first iteration
    async *stream() {
      throw new Error('gateway exploded');
    },
    async complete(): Promise<ModelResult> {
      throw new Error('gateway exploded');
    }
  };
  const { agent, clientStream } = pipe();
  connectAcp(buildHandlers(failing), agent);

  await makeClientApp([]).connectWith(clientStream, async (ctx) => {
    await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await ctx.request('session/new', { cwd: '/tmp', mcpServers: [] });
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] })
      ).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

test('delegated session routes file_write to the editor via reverse-RPC', async () => {
  const writes: { path: string; content: string }[] = [];

  const { agent, clientStream } = pipe();
  connectAcp(
    buildHandlers(
      scriptedModel([{ tool: 'file_write', input: { path: '/proj/x.ts', content: 'hi' } }, 'done']),
      undefined,
      { tools: [fileWriteTool as Tool] }
    ),
    agent
  );

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
    .onRequest('fs/read_text_file', () => {
      throw new Error('not found');
    })
    .connectWith(clientStream, async (ctx) => {
      await ctx.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }
      });
      const { sessionId } = await ctx.request('session/new', { cwd: '/proj', mcpServers: [] });
      await ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'write the file' }] });

      // The write landed in the editor (reverse-RPC), NOT on the daemon disk.
      expect(writes).toEqual([{ path: '/proj/x.ts', content: 'hi' }]);
    });
});

test('image content blocks reach the model as a multimodal user message', async () => {
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
  const { agent, clientStream } = pipe();
  connectAcp(buildHandlers(capturing), agent);

  await makeClientApp([]).connectWith(clientStream, async (ctx) => {
    await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await ctx.request('session/new', { cwd: '/tmp', mcpServers: [] });

    const data = Buffer.from('fake-png-bytes').toString('base64');
    await ctx.request('session/prompt', {
      sessionId,
      prompt: [
        { type: 'text', text: 'what is this?' },
        { type: 'image', data, mimeType: 'image/png' }
      ]
    });

    const lastUser = [...(captured ?? [])].reverse().find((m) => m.role === 'user');
    expect(Array.isArray(lastUser?.content)).toBe(true);
    const parts = lastUser?.content as Array<{ type: string }>;
    expect(parts.some((p) => p.type === 'image')).toBe(true);
    expect(parts.some((p) => p.type === 'text')).toBe(true);
  });
});

test('listSessions reports the cwd for sessions opened on this connection, empty-string for others', async () => {
  const { agent, clientStream } = pipe();
  connectAcp(buildHandlers(mockModel()), agent);

  await makeClientApp([]).connectWith(clientStream, async (ctx) => {
    await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });

    const { sessionId: s1 } = await ctx.request('session/new', { cwd: '/projects/alpha', mcpServers: [] });
    const { sessionId: s2 } = await ctx.request('session/new', { cwd: '/projects/beta', mcpServers: [] });

    const list = await ctx.request('session/list', {});
    const found1 = list.sessions.find((s) => s.sessionId === s1);
    const found2 = list.sessions.find((s) => s.sessionId === s2);
    expect(found1?.cwd).toBe('/projects/alpha');
    expect(found2?.cwd).toBe('/projects/beta');
  });
});

test('a high-risk tool routes approval through the editor (allow → tool runs)', async () => {
  let ran = 0;
  const danger: Tool = {
    name: 'danger',
    description: 'high-risk probe',
    scopes: [],
    highRisk: true,
    async run() {
      ran++;
      return toolResult('did it');
    }
  };
  let asked = 0;
  const { agent, clientStream } = pipe();
  connectAcp(buildHandlers(scriptedModel([{ tool: 'danger' }, 'done']), undefined, { tools: [danger] }), agent);

  await acpClient()
    .onNotification('session/update', () => {})
    .onRequest('session/request_permission', (): RequestPermissionResponse => {
      asked++;
      return { outcome: { outcome: 'selected', optionId: 'allow' } };
    })
    .connectWith(clientStream, async (ctx) => {
      await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const { sessionId } = await ctx.request('session/new', { cwd: '/tmp', mcpServers: [] });
      const res = await ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'do it' }] });

      expect(asked).toBe(1);
      expect(ran).toBe(1);
      expect(res.stopReason).toBe('end_turn');
    });
});

test('a high-risk tool is denied when the editor rejects', async () => {
  let ran = 0;
  const danger: Tool = {
    name: 'danger',
    description: 'high-risk probe',
    scopes: [],
    highRisk: true,
    async run() {
      ran++;
      return toolResult('did it');
    }
  };
  const { agent, clientStream } = pipe();
  connectAcp(buildHandlers(scriptedModel([{ tool: 'danger' }, 'done']), undefined, { tools: [danger] }), agent);

  await acpClient()
    .onNotification('session/update', () => {})
    .onRequest(
      'session/request_permission',
      (): RequestPermissionResponse => ({
        outcome: { outcome: 'selected', optionId: 'reject' }
      })
    )
    .connectWith(clientStream, async (ctx) => {
      await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const { sessionId } = await ctx.request('session/new', { cwd: '/tmp', mcpServers: [] });
      await ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'do it' }] });

      expect(ran).toBe(0); // gate denied → tool never executed
    });
});

// NOTE: `available_commands_update` now forwards the daemon's unified command registry
// (handlers.commands.list = built-ins + atom pack commands + user-invocable skills). The ACP layer just maps
// available commands → the update; coverage of the registry itself lives with that module. The
// test harness doesn't wire deps.commands, so there's no ACP-level assertion here.

test('open documents are synced and surfaced to the model as ambient context', async () => {
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
  const { agent, clientStream } = pipe();
  connectAcp(buildHandlers(capturing), agent);

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
    // An incremental edit replaces "42" with "43".
    await ctx.notify('document/didChange', {
      sessionId,
      uri: 'file:///proj/a.ts',
      version: 2,
      contentChanges: [{ range: { start: { line: 0, character: 15 }, end: { line: 0, character: 17 } }, text: '43' }]
    });
    await ctx.notify('document/didFocus', {
      sessionId,
      uri: 'file:///proj/a.ts',
      version: 2,
      position: { line: 0, character: 0 },
      visibleRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 18 } }
    });
    // Notifications are fire-and-forget; yield the event loop so the server processes
    // didFocusDocument before the prompt request is dispatched.
    await new Promise((r) => setTimeout(r, 0));

    await ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'what is answer?' }] });

    // Ambient context rides the last USER message (kept out of the cached system prompt), as a text part.
    const lastUser = [...(captured ?? [])].reverse().find((m) => m.role === 'user');
    const parts = (Array.isArray(lastUser?.content) ? lastUser?.content : []) as Array<{ type: string; text?: string }>;
    const ambient = parts.map((p) => p.text ?? '').join('\n');
    expect(ambient).toContain('file:///proj/a.ts');
    expect(ambient).toContain('(focused)');
    expect(ambient).toContain('const answer = 43;'); // incremental edit applied
    // The system prompt must NOT contain the volatile doc content (so its cache breakpoint holds).
    const system = (captured ?? []).find((m) => m.role === 'system');
    expect(typeof system?.content === 'string' ? system.content : '').not.toContain('const answer');
  });
});

test('newSession pushes a session_info_update carrying the title', async () => {
  const { agent, clientStream } = pipe();
  connectAcp(buildHandlers(mockModel()), agent);
  const updates: SessionNotification[] = [];

  await makeClientApp(updates).connectWith(clientStream, async (ctx) => {
    await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await ctx.request('session/new', { cwd: '/tmp', mcpServers: [] });
    await new Promise((r) => setTimeout(r, 20)); // flush fire-and-forget notifications

    const info = updates.find((u) => u.update.sessionUpdate === 'session_info_update');
    expect((info?.update as { title?: string }).title).toBe('ACP session');
  });
});

test('session/resume re-attaches without replaying history', async () => {
  const { agent, clientStream } = pipe();
  connectAcp(buildHandlers(mockModel()), agent);
  const updates: SessionNotification[] = [];

  await makeClientApp(updates).connectWith(clientStream, async (ctx) => {
    const init = await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    expect(init.agentCapabilities?.sessionCapabilities?.resume).toEqual({});

    const { sessionId } = await ctx.request('session/new', { cwd: '/tmp', mcpServers: [] });
    await ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] });

    updates.length = 0;
    await ctx.request('session/resume', { sessionId, cwd: '/tmp', mcpServers: [] });
    await new Promise((r) => setTimeout(r, 20));
    // resume must NOT replay the transcript (unlike load)…
    expect(updates.filter((u) => u.update.sessionUpdate.endsWith('message_chunk')).length).toBe(0);
    // …but still surfaces session info.
    expect(updates.some((u) => u.update.sessionUpdate === 'session_info_update')).toBe(true);
  });
});

test('a non-delegated session scopes fs to the client cwd + additionalDirectories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monad-acp-cwd-'));
  try {
    await writeFile(join(dir, 'inside.txt'), 'inside-content');
    const { agent, clientStream } = pipe();
    // Model reads a file inside cwd (allowed) then one outside (rejected by the session sandbox).
    connectAcp(
      buildHandlers(
        scriptedModel([
          { tool: 'file_read', input: { path: join(dir, 'inside.txt') } },
          { tool: 'file_read', input: { path: '/etc/hosts' } },
          'done'
        ]),
        undefined,
        { tools: [fileReadTool as Tool] }
      ),
      agent
    );
    const updates: SessionNotification[] = [];
    // The out-of-cwd read triggers a path-expansion permission prompt; the editor declines it, so the
    // read stays sandbox-rejected. (An 'allow' here would consent to the expansion — that path is the
    // "high-risk tool routes approval through the editor" test, not this one.)
    await makeClientApp(updates, 'reject').connectWith(clientStream, async (ctx) => {
      // clientCapabilities:{} → non-delegated, so monad's sandbox backend runs, scoped to cwd.
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
    await rm(dir, { recursive: true, force: true });
  }
});

test('session/delete removes the session from the list', async () => {
  const { agent, clientStream } = pipe();
  connectAcp(buildHandlers(mockModel()), agent);

  await makeClientApp([]).connectWith(clientStream, async (ctx) => {
    await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await ctx.request('session/new', { cwd: '/tmp', mcpServers: [] });
    expect((await ctx.request('session/list', {})).sessions.some((s) => s.sessionId === sessionId)).toBe(true);
    await ctx.request('session/delete', { sessionId });
    expect((await ctx.request('session/list', {})).sessions.some((s) => s.sessionId === sessionId)).toBe(false);
  });
});

test('didCloseDocument removes the doc from ambient context and clears focusedUri', async () => {
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
  const { agent, clientStream } = pipe();
  connectAcp(buildHandlers(capturing), agent);

  await makeClientApp([]).connectWith(clientStream, async (ctx) => {
    await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await ctx.request('session/new', { cwd: '/proj', mcpServers: [] });

    // Open and focus a document.
    await ctx.notify('document/didOpen', {
      sessionId,
      uri: 'file:///proj/b.ts',
      languageId: 'typescript',
      text: 'SECRET=42',
      version: 1
    });
    await ctx.notify('document/didFocus', {
      sessionId,
      uri: 'file:///proj/b.ts',
      version: 1,
      position: { line: 0, character: 0 },
      visibleRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } }
    });
    // Close it — should be removed from docs and focused uri cleared.
    await ctx.notify('document/didClose', { sessionId, uri: 'file:///proj/b.ts' });

    await ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'what do you see?' }] });

    const lastUser = [...(captured ?? [])].reverse().find((m) => m.role === 'user');
    const text = Array.isArray(lastUser?.content)
      ? (lastUser?.content as Array<{ text?: string }>).map((p) => p.text ?? '').join('')
      : String(lastUser?.content ?? '');
    expect(text).not.toContain('SECRET=42');
    expect(text).not.toContain('(focused)');
  });
});

test('MCQ clarify_ask is bridged to the client as requestPermission and the answer feeds back', async () => {
  let clarifyAsked = 0;
  const { agent, clientStream } = pipe();
  // Model calls clarify_ask with options then yields a final text turn.
  connectAcp(
    buildHandlers(
      scriptedModel([{ tool: 'clarify_ask', input: { question: 'Which?', options: ['A', 'B'] } }, 'done']),
      undefined,
      { clarifyTool: true }
    ),
    agent
  );

  await acpClient()
    .onNotification('session/update', () => {})
    .onRequest('session/request_permission', (): RequestPermissionResponse => {
      clarifyAsked++;
      // option '1' → second choice ('B')
      return { outcome: { outcome: 'selected', optionId: '1' } };
    })
    .connectWith(clientStream, async (ctx) => {
      await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const { sessionId } = await ctx.request('session/new', { cwd: '/tmp', mcpServers: [] });
      const res = await ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'ask me' }] });

      expect(clarifyAsked).toBe(1);
      expect(res.stopReason).toBe('end_turn');
    });
});

test('connection disconnect aborts all in-flight sessions', async () => {
  // Build a custom pipe so we can close the write end to simulate an editor crash / disconnect.
  const c2a = new TransformStream<Uint8Array, Uint8Array>();
  const a2c = new TransformStream<Uint8Array, Uint8Array>();

  const handlers = buildHandlers(mockModel(undefined, 100)); // 100 ms per token — keeps the run in-flight
  const agentConn = connectAcp(handlers, ndJsonStream(a2c.writable, c2a.readable));
  const abortSpy = spyOn(handlers.session, 'abort');

  const updates: SessionNotification[] = [];
  const clientStream = ndJsonStream(c2a.writable, a2c.readable);
  let sessionId = '';

  await makeClientApp(updates)
    .connectWith(clientStream, async (ctx) => {
      await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      ({ sessionId } = await ctx.request('session/new', { cwd: '/tmp', mcpServers: [] }));

      // Fire the prompt without waiting — the slow model keeps the run in-flight.
      void ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] }).catch(() => {});

      // Wait for the first streaming notification — confirms the run loop is executing and the model
      // is in-flight.  This is reliable regardless of CI load; the sleep(50) it replaced was not.
      while (updates.length === 0) await Bun.sleep(5);

      // Simulate editor crash: close the client→agent write channel so the agent gets EOF.
      await c2a.writable.close();
    })
    .catch((err: unknown) => {
      if (!(err instanceof TypeError) || !err.message.includes('stream is closing or closed')) throw err;
    });

  // Wait for the agent-side connection to close, then flush microtasks so the signal handler fires.
  await agentConn.closed;
  await Bun.sleep(0);

  expect(abortSpy).toHaveBeenCalledWith({ id: sessionId });
});

test('session/cancel stops the turn with stopReason cancelled', async () => {
  const { agent, clientStream } = pipe();
  // Space tokens out so cancel lands mid-stream.
  connectAcp(buildHandlers(mockModel(undefined, 30)), agent);
  const updates: SessionNotification[] = [];

  await makeClientApp(updates).connectWith(clientStream, async (ctx) => {
    await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await ctx.request('session/new', { cwd: '/tmp', mcpServers: [] });

    const promptP = ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
    await Bun.sleep(40);
    await ctx.notify('session/cancel', { sessionId });

    const res = await promptP;
    expect(res.stopReason).toBe('cancelled');
  });
});
