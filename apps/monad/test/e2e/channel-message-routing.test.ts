import type { MonadPaths } from '@monad/home';
import type { Agent, Event, Session, SessionId, SessionUiEvent, UIMessageItem, UIPart } from '@monad/protocol';
import type { ModelChunk, ModelRequest, ModelRouter } from '@/agent/model/index.ts';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initMonadHome, loadAuth, loadConfig } from '@monad/home';

import { ModelService } from '@/handlers/settings/model/index.ts';
import { clearAcpDelegatesForSession } from '@/services/delegation/acp-delegate.ts';
import { createHttpTransport } from '@/transports/http.ts';
import {
  buildHandlers,
  makeTestPaths,
  seededProviderRegistry,
  serveTransport,
  TRANSPORTS,
  type TransportHandle
} from '../helpers.ts';

const CHANNEL_HOST_EXT_KEY = 'controlRoomModeratorAgentId';
const acpFixture = resolve(import.meta.dir, '../fixtures/mock-acp-agent.ts');

function makePaths(base: string): MonadPaths {
  return makeTestPaths(base);
}

const json = (method: string, body?: unknown, headers?: Record<string, string>): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', ...headers },
  body: body === undefined ? undefined : JSON.stringify(body)
});

async function createSession(t: TransportHandle, cwd?: string): Promise<string> {
  const res = await t.fetch(
    '/v1/sessions',
    json('POST', {
      title: 'Control Room: routing',
      origin: { surface: 'web', client: 'control-room' },
      ...(cwd ? { cwd } : {})
    })
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { sessionId: string }).sessionId;
}

async function getSession(t: TransportHandle, sessionId: string): Promise<Session> {
  const res = await t.fetch(`/v1/sessions/${sessionId}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { session: Session }).session;
}

async function createAgent(t: TransportHandle): Promise<Agent> {
  const res = await t.fetch('/v1/agents', json('POST', { name: 'Channel Host', prompt: 'Route channel messages.' }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { agent: Agent }).agent;
}

async function listMessages(t: TransportHandle, sessionId: string): Promise<Array<{ role: string; text: string }>> {
  const listed = await t.fetch(`/v1/sessions/${sessionId}/messages`);
  expect(listed.status).toBe(200);
  return ((await listed.json()) as { messages: Array<{ role: string; text: string }> }).messages;
}

async function waitForMessages(
  t: TransportHandle,
  sessionId: string,
  count: number
): Promise<Array<{ role: string; text: string }>> {
  for (let i = 0; i < 20; i++) {
    const messages = await listMessages(t, sessionId);
    if (messages.length >= count) return messages;
    await Bun.sleep(25);
  }
  return listMessages(t, sessionId);
}

function captureModel(requests: ModelRequest[], replies: string[]): ModelRouter {
  return {
    async *stream(req): AsyncIterable<ModelChunk> {
      requests.push(req);
      yield { type: 'text', token: replies.shift() ?? 'unexpected assistant' };
    },
    async complete(req) {
      requests.push(req);
      return { text: replies.shift() ?? 'unexpected assistant', finishReason: 'stop' };
    }
  };
}

function requestText(req: ModelRequest): string {
  return req.messages
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((part): part is Extract<(typeof message.content)[number], { type: 'text' }> => part.type === 'text')
            .map((part) => part.text)
            .join('\n')
    )
    .join('\n');
}

async function configureMockNativeCliAgent(
  t: TransportHandle,
  root: string,
  opts: { authState?: 'authenticated' | 'unauthenticated' | 'unknown' } = {}
): Promise<{ stdinLog: string }> {
  const script = join(root, 'mock-native-cli.js');
  const stdinLog = join(root, 'mock-native-cli-stdin.log');
  await writeFile(
    script,
    [
      '#!/usr/bin/env bun',
      'import { appendFileSync } from "node:fs";',
      `const stdinLog = ${JSON.stringify(stdinLog)};`,
      `const authState = ${JSON.stringify(opts.authState ?? 'authenticated')};`,
      'const args = process.argv.slice(2).join(" ");',
      'if (args === "login status") {',
      '  process.stdout.write(JSON.stringify({ state: authState }) + "\\n");',
      '  process.exit(0);',
      '}',
      'process.stdout.write("native-ready\\n");',
      'process.stdin.on("data", (d) => {',
      '  appendFileSync(stdinLog, d.toString());',
      '  process.stdout.write("native-echo:" + d.toString());',
      '});',
      'setInterval(() => {}, 1000);'
    ].join('\n')
  );
  await chmod(script, 0o755);
  const res = await t.fetch(
    '/v1/settings/native-cli-agents',
    json('PUT', {
      agent: {
        name: 'codex',
        provider: 'codex',
        command: script,
        args: [],
        enabled: true,
        defaultLaunchMode: 'pty',
        allowDangerousMode: false,
        approvalOwnership: 'provider-owned'
      }
    })
  );
  expect(res.status).toBe(200);
  return { stdinLog };
}

async function waitForFile(path: string, expected: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const text = await readFile(path, 'utf8').catch(() => '');
    if (text.includes(expected)) return text;
    await Bun.sleep(25);
  }
  return readFile(path, 'utf8');
}

function uiMessageText(item: UIMessageItem): string {
  return item.parts
    .filter((part): part is Extract<UIPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

for (const kind of TRANSPORTS) {
  describe(`channel message routing over ${kind}`, () => {
    let dir: string;
    let t: TransportHandle;
    let modelRequests: ModelRequest[];
    let modelReplies: string[];

    beforeEach(async () => {
      modelRequests = [];
      modelReplies = [];
      dir = join(tmpdir(), `monad-channel-routing-${Date.now()}-${process.hrtime.bigint()}`);
      const paths = makePaths(dir);
      await initMonadHome(paths);
      const cfg = await loadConfig(paths.config);
      if (!cfg) throw new Error('config missing after init');
      const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry());
      t = serveTransport(
        kind,
        createHttpTransport(buildHandlers(captureModel(modelRequests, modelReplies), { paths, modelService }))
      );
    });

    afterEach(async () => {
      await t.stop();
      await rm(dir, { recursive: true, force: true });
    });

    test('Studio host is stored as channel host metadata and binds the session agent', async () => {
      const sessionId = await createSession(t);
      const agent = await createAgent(t);
      const session = await getSession(t, sessionId);
      const origin = {
        ...session.origin,
        ext: { ...(session.origin?.ext ?? {}), [CHANNEL_HOST_EXT_KEY]: `agent:${agent.id}` }
      };

      const res = await t.fetch(`/v1/sessions/${sessionId}`, json('PATCH', { agentId: agent.id, origin }));
      expect(res.status).toBe(200);
      const updated = ((await res.json()) as { session: Session }).session;
      expect(updated.agentIds).toEqual([agent.id]);
      expect(updated.origin?.ext?.[CHANNEL_HOST_EXT_KEY]).toBe(`agent:${agent.id}`);
    });

    test('Studio host receives bare channel messages through the channel route', async () => {
      const sessionId = await createSession(t);
      const agent = await createAgent(t);
      const session = await getSession(t, sessionId);
      const origin = {
        ...session.origin,
        ext: { ...(session.origin?.ext ?? {}), [CHANNEL_HOST_EXT_KEY]: `agent:${agent.id}` }
      };
      const hostRes = await t.fetch(`/v1/sessions/${sessionId}`, json('PATCH', { agentId: agent.id, origin }));
      expect(hostRes.status).toBe(200);

      const send = await t.fetch(`/v1/channels/${sessionId}/messages`, json('POST', { text: 'route this' }));
      expect(send.status).toBe(200);
      expect(await send.json()).toEqual({ accepted: true });

      const messages = await waitForMessages(t, sessionId, 2);
      expect(messages.map((message) => [message.role, message.text])).toEqual([
        ['user', 'route this'],
        ['assistant', 'unexpected assistant']
      ]);
      expect(modelRequests).toHaveLength(1);
      const prompt = requestText(modelRequests[0] as ModelRequest);
      expect(prompt).toContain('<channel_context>');
      expect(prompt).toContain('target_role: moderator');
      expect(prompt).toContain('You are the moderator for this channel');
      expect(prompt).toContain('Return exactly one JSON object and no surrounding prose.');
      expect(prompt).toContain(
        'Shape: {"visibility":"visible","display":{"kind":"markdown","content":"text shown to the user"}'
      );
    });

    test('ACP host is stored as channel host metadata without binding a Studio agent', async () => {
      const sessionId = await createSession(t);
      const session = await getSession(t, sessionId);
      const origin = {
        ...session.origin,
        ext: { ...(session.origin?.ext ?? {}), [CHANNEL_HOST_EXT_KEY]: 'acp:reviewer' }
      };

      const res = await t.fetch(`/v1/sessions/${sessionId}`, json('PATCH', { agentId: null, origin }));
      expect(res.status).toBe(200);
      const updated = ((await res.json()) as { session: Session }).session;
      expect(updated.agentIds).toEqual([]);
      expect(updated.origin?.ext?.[CHANNEL_HOST_EXT_KEY]).toBe('acp:reviewer');
    });

    test('clearing host removes channel host metadata and keeps the channel unbound', async () => {
      const sessionId = await createSession(t);
      const session = await getSession(t, sessionId);
      const ext = { ...(session.origin?.ext ?? {}), [CHANNEL_HOST_EXT_KEY]: 'acp:reviewer' };
      const withHost = { ...session.origin, ext };
      const setRes = await t.fetch(`/v1/sessions/${sessionId}`, json('PATCH', { agentId: null, origin: withHost }));
      expect(setRes.status).toBe(200);

      const next = ((await setRes.json()) as { session: Session }).session;
      const nextExt = { ...(next.origin?.ext ?? {}) };
      delete nextExt[CHANNEL_HOST_EXT_KEY];
      const clearedOrigin = { ...next.origin, ext: nextExt };
      const clearRes = await t.fetch(
        `/v1/sessions/${sessionId}`,
        json('PATCH', { agentId: null, origin: clearedOrigin })
      );
      expect(clearRes.status).toBe(200);
      const cleared = ((await clearRes.json()) as { session: Session }).session;
      expect(cleared.agentIds).toEqual([]);
      expect(cleared.origin?.ext?.[CHANNEL_HOST_EXT_KEY]).toBeUndefined();
    });

    test('no-host project message records timeline only through the project route', async () => {
      const sessionId = await createSession(t);
      const oldRoute = await t.fetch(
        `/v1/sessions/${sessionId}/room/messages`,
        json('POST', { text: 'timeline only' })
      );
      expect(oldRoute.status).toBe(404);

      const send = await t.fetch(`/v1/projects/${sessionId}/messages`, json('POST', { text: 'timeline only' }));
      expect(send.status).toBe(200);
      expect(send.headers.get('content-type')).toContain('application/json');
      expect(await send.json()).toEqual({ accepted: true });

      await Bun.sleep(50);
      const messages = await listMessages(t, sessionId);
      expect(messages.map((message) => [message.role, message.text])).toEqual([['user', 'timeline only']]);
      expect(modelRequests).toEqual([]);
    });

    test('native CLI mention forwards input to the provider-owned CLI session through the project route', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockNativeCliAgent(t, dir);
      const sessionId = await createSession(t, projectDir);

      const eventsP = t.sse(`/v1/sessions/${sessionId}/events`, {
        until: (event) =>
          event.type === 'native_cli.output' &&
          String((event.payload as { chunk?: unknown }).chunk).includes('inspect repo'),
        timeoutMs: 3000
      });
      const send = await t.fetch(
        `/v1/projects/${sessionId}/messages`,
        json('POST', { text: '@[name="codex" id="native-cli:codex"] inspect repo' })
      );
      if (send.status !== 200) throw new Error(await send.text());
      expect(send.status).toBe(200);
      expect(await send.json()).toEqual({ accepted: true });

      expect(await waitForFile(stdinLog, 'inspect repo\n')).toContain('inspect repo\n');
      const messages = await waitForMessages(t, sessionId, 1);
      expect(messages[0]?.text).toBe('@[name="codex" id="native-cli:codex"] inspect repo');
      const events = await eventsP;
      expect(events.some((event) => event.type === 'native_cli.started' && event.payload.agentName === 'codex')).toBe(
        true
      );
      const listed = await t.fetch(`/v1/sessions/${sessionId}/native-cli-sessions`);
      expect(listed.status).toBe(200);
      const nativeSessionId = ((await listed.json()) as { sessions: Array<{ id: string }> }).sessions[0]?.id;
      expect(typeof nativeSessionId).toBe('string');
      await t.fetch(`/v1/native-cli-sessions/${nativeSessionId}/stop`, json('POST'));
    });

    test('native CLI mention requires Studio reconnect when provider auth status is unauthenticated', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockNativeCliAgent(t, dir, { authState: 'unauthenticated' });
      const sessionId = await createSession(t, projectDir);

      const eventsP = t.sse(`/v1/sessions/${sessionId}/events`, {
        until: (event) => event.type === 'native_cli.connection_required',
        timeoutMs: 3000
      });
      const send = await t.fetch(
        `/v1/projects/${sessionId}/messages`,
        json('POST', { text: '@[name="codex" id="native-cli:codex"] inspect repo' })
      );
      if (send.status !== 200) throw new Error(await send.text());
      expect(send.status).toBe(200);
      expect(await send.json()).toEqual({ accepted: true });

      const events = await eventsP;
      expect(events.at(-1)?.payload).toMatchObject({
        agentName: 'codex',
        provider: 'codex',
        reconnectIn: 'studio'
      });
      const stdinText = await readFile(stdinLog, 'utf8').catch(() => '');
      expect(stdinText).toBe('');
      const messages = await waitForMessages(t, sessionId, 2);
      expect(messages[0]?.text).toBe('@[name="codex" id="native-cli:codex"] inspect repo');
      expect(messages[1]?.text).toContain('Reconnect codex in Studio');
    });

    test('native CLI mention requires Studio check when provider readiness is unknown', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockNativeCliAgent(t, dir, { authState: 'unknown' });
      const sessionId = await createSession(t, projectDir);

      const send = await t.fetch(
        `/v1/projects/${sessionId}/messages`,
        json('POST', { text: '@[name="codex" id="native-cli:codex"] inspect repo' })
      );
      if (send.status !== 200) throw new Error(await send.text());
      expect(await send.json()).toEqual({ accepted: true });

      const stdinText = await readFile(stdinLog, 'utf8').catch(() => '');
      expect(stdinText).toBe('');
      const messages = await waitForMessages(t, sessionId, 2);
      expect(messages[0]?.text).toBe('@[name="codex" id="native-cli:codex"] inspect repo');
      expect(messages[1]?.text).toContain('Check codex connection in Studio');
    });

    test('native CLI mention without project working path records user message and visible error', async () => {
      await configureMockNativeCliAgent(t, dir);
      const sessionId = await createSession(t);
      const send = await t.fetch(
        `/v1/projects/${sessionId}/messages`,
        json('POST', { text: '@[name="codex" id="native-cli:codex"] inspect repo' })
      );
      expect(send.status).toBe(200);
      expect(await send.json()).toEqual({ accepted: true });

      const messages = await waitForMessages(t, sessionId, 2);
      expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
      expect(messages[0]?.text).toBe('@[name="codex" id="native-cli:codex"] inspect repo');
      expect(messages[1]?.text).toContain('requires a project working path');
    });

    test('ACP host receives channel protocol and user message through the channel route', async () => {
      const sessionId = await createSession(t);
      const register = await t.fetch(
        '/v1/settings/acp-agents',
        json('PUT', {
          agent: {
            name: 'reviewer',
            command: 'bun',
            args: [acpFixture],
            enabled: true,
            osSandbox: false,
            forwardMcp: false
          }
        })
      );
      expect(register.status).toBe(200);

      const session = await getSession(t, sessionId);
      const origin = {
        ...session.origin,
        ext: { ...(session.origin?.ext ?? {}), [CHANNEL_HOST_EXT_KEY]: 'acp:reviewer' }
      };
      const hostRes = await t.fetch(`/v1/sessions/${sessionId}`, json('PATCH', { agentId: null, origin }));
      expect(hostRes.status).toBe(200);

      const send = await t.fetch(`/v1/channels/${sessionId}/messages`, json('POST', { text: 'review this' }));
      expect(send.status).toBe(200);
      expect(await send.json()).toEqual({ accepted: true });

      const messages = await waitForMessages(t, sessionId, 2);
      const assistant = messages.find((message) => message.role === 'assistant')?.text ?? '';
      expect(assistant).toContain('mock-acp handled: <channel_context>');
      expect(assistant).toContain('target: reviewer');
      expect(assistant).toContain('target_role: moderator');
      expect(assistant).toContain('Return exactly one JSON object and no surrounding prose.');
      expect(assistant).toContain('<channel_user_message>\nreview this\n</channel_user_message>');
      clearAcpDelegatesForSession(sessionId as SessionId);
    });

    test('ACP moderator structured next dispatches an ACP task', async () => {
      const sessionId = await createSession(t);
      for (const name of ['host', 'codex']) {
        const register = await t.fetch(
          '/v1/settings/acp-agents',
          json('PUT', {
            agent: {
              name,
              command: 'bun',
              args: [acpFixture],
              enabled: true,
              osSandbox: false,
              forwardMcp: false
            }
          })
        );
        expect(register.status).toBe(200);
      }

      const session = await getSession(t, sessionId);
      const origin = {
        ...session.origin,
        ext: { ...(session.origin?.ext ?? {}), [CHANNEL_HOST_EXT_KEY]: 'acp:host' }
      };
      const hostRes = await t.fetch(`/v1/sessions/${sessionId}`, json('PATCH', { agentId: null, origin }));
      expect(hostRes.status).toBe(200);

      const eventsP = t.sse(`/v1/sessions/${sessionId}/events`, {
        until: (event) =>
          event.type === 'agent.message' && (event.payload as { agentName?: unknown }).agentName === 'codex',
        timeoutMs: 3000
      });
      await Bun.sleep(50);
      const send = await t.fetch(`/v1/channels/${sessionId}/messages`, json('POST', { text: 'structured-next' }));
      expect(send.status).toBe(200);

      const events = await eventsP;
      expect(
        events.some(
          (event: Event) =>
            event.type === 'tool.called' &&
            (event.payload as { tool?: unknown; input?: { agent?: unknown } }).tool === 'acp:codex' &&
            (event.payload as { input?: { agent?: unknown } }).input?.agent === 'codex'
        )
      ).toBe(true);
      expect(
        events.some(
          (event: Event) =>
            event.type === 'agent.message' && (event.payload as { agentName?: unknown }).agentName === 'codex'
        )
      ).toBe(true);
      clearAcpDelegatesForSession(sessionId as SessionId);
    });

    test('ACP moderator receives single explicit mentions as routing constraints', async () => {
      const sessionId = await createSession(t);
      for (const name of ['host', 'codex']) {
        const register = await t.fetch(
          '/v1/settings/acp-agents',
          json('PUT', {
            agent: {
              name,
              command: 'bun',
              args: [acpFixture],
              enabled: true,
              osSandbox: false,
              forwardMcp: false
            }
          })
        );
        expect(register.status).toBe(200);
      }

      const session = await getSession(t, sessionId);
      const origin = {
        ...session.origin,
        ext: { ...(session.origin?.ext ?? {}), [CHANNEL_HOST_EXT_KEY]: 'acp:host' }
      };
      const hostRes = await t.fetch(`/v1/sessions/${sessionId}`, json('PATCH', { agentId: null, origin }));
      expect(hostRes.status).toBe(200);

      const eventsP = t.sse(`/v1/sessions/${sessionId}/events`, {
        until: (event) => event.type === 'agent.message',
        timeoutMs: 3000
      });
      await Bun.sleep(50);
      const mention = '@[name="codex" id="acp:codex"]';
      const send = await t.fetch(`/v1/channels/${sessionId}/messages`, json('POST', { text: `${mention} inspect` }));
      expect(send.status).toBe(200);

      const events = await eventsP;
      const toolCalls = events.filter((event: Event) => event.type === 'tool.called');
      expect(toolCalls[0]?.payload).toMatchObject({ tool: 'acp:host', input: { agent: 'host' } });
      expect(toolCalls[0]?.payload).not.toMatchObject({ tool: 'acp:codex' });
      const assistant = events.find((event: Event) => event.type === 'agent.message')?.payload as
        | { text?: string; agentName?: string }
        | undefined;
      expect(assistant?.agentName).toBe('host');
      expect(assistant?.text).toContain('target_constraint: codex (acp:codex)');
      expect(assistant?.text).toContain('set visibility to "silent"');
      clearAcpDelegatesForSession(sessionId as SessionId);
    });

    test('moderator structured next dispatches parallel ACP tasks and transcript renders display content', async () => {
      const sessionId = await createSession(t);
      const agent = await createAgent(t);
      for (const name of ['codex', 'claude-code']) {
        const register = await t.fetch(
          '/v1/settings/acp-agents',
          json('PUT', {
            agent: {
              name,
              command: 'bun',
              args: [acpFixture],
              enabled: true,
              osSandbox: false,
              forwardMcp: false
            }
          })
        );
        expect(register.status).toBe(200);
      }

      const session = await getSession(t, sessionId);
      const origin = {
        ...session.origin,
        ext: { ...(session.origin?.ext ?? {}), [CHANNEL_HOST_EXT_KEY]: `agent:${agent.id}` }
      };
      const hostRes = await t.fetch(`/v1/sessions/${sessionId}`, json('PATCH', { agentId: agent.id, origin }));
      expect(hostRes.status).toBe(200);
      modelReplies.push(
        JSON.stringify({
          display: { kind: 'markdown', content: "I'll ask the codex agent to check the current time." },
          attachments: [],
          next: [
            {
              agentId: 'acp:codex',
              title: 'Check current time',
              prompt: 'What time is it right now?',
              context: 'User asked to check what time it is'
            },
            {
              agentId: 'acp:claude-code',
              title: 'Check current time',
              prompt: 'What time is it right now?',
              context: 'User asked to check what time it is'
            }
          ]
        })
      );

      const eventsP = t.sse(`/v1/sessions/${sessionId}/events`, {
        until: (event) =>
          event.type === 'tool.called' &&
          (event.payload as { tool?: unknown; input?: { agent?: unknown } }).tool === 'acp:claude-code',
        timeoutMs: 3000
      });
      const uiEventsP = t.sse(`/v1/sessions/${sessionId}/ui-stream`, {
        until: (event) => {
          const uiEvent = event as unknown as SessionUiEvent;
          return (
            uiEvent.kind === 'upsert' &&
            uiEvent.item.kind === 'message' &&
            uiEvent.item.role === 'assistant' &&
            uiEvent.item.status === 'done' &&
            uiMessageText(uiEvent.item) === "I'll ask the codex agent to check the current time."
          );
        },
        timeoutMs: 3000
      });
      await Bun.sleep(50);
      const send = await t.fetch(`/v1/channels/${sessionId}/messages`, json('POST', { text: 'what time is it?' }));
      expect(send.status).toBe(200);
      expect(await send.json()).toEqual({ accepted: true });

      const events = await eventsP;
      for (const name of ['codex', 'claude-code']) {
        expect(
          events.some(
            (event: Event) =>
              event.type === 'tool.called' &&
              (event.payload as { tool?: unknown; input?: { agent?: unknown } }).tool === `acp:${name}` &&
              (event.payload as { input?: { agent?: unknown } }).input?.agent === name
          )
        ).toBe(true);
      }
      const uiEvents = (await uiEventsP) as unknown as SessionUiEvent[];
      const hostUiMessage = uiEvents
        .filter((event) => event.kind === 'upsert' && event.item.kind === 'message' && event.item.role === 'assistant')
        .map((event) => (event.kind === 'upsert' && event.item.kind === 'message' ? event.item : null))
        .find((item) => item && uiMessageText(item) === "I'll ask the codex agent to check the current time.");
      expect(hostUiMessage ? uiMessageText(hostUiMessage) : '').not.toContain('"display"');

      const messages = await waitForMessages(t, sessionId, 4);
      expect(messages[1]?.text).toContain('"display"');
      const delegated = messages.filter(
        (message) => message.role === 'assistant' && message.text.includes('Task: Check current time')
      );
      expect(delegated).toHaveLength(2);
      for (const message of delegated) expect(message.text).toContain('What time is it right now?');
      clearAcpDelegatesForSession(sessionId as SessionId);
    });

    test('moderator structured next forwards session runtime MCP servers to ACP workers', async () => {
      const sessionId = await createSession(t);
      const agent = await createAgent(t);
      const runtimeRes = await t.fetch(
        `/v1/sessions/${sessionId}/runtime`,
        json('PUT', {
          sandboxRoots: [dir],
          mcpServers: [
            {
              name: 'session-mcp',
              command: 'bun',
              args: [resolve(import.meta.dir, '../unit/tools/fixtures/mock-mcp-server.ts')]
            }
          ]
        })
      );
      expect(runtimeRes.status).toBe(200);
      const register = await t.fetch(
        '/v1/settings/acp-agents',
        json('PUT', {
          agent: {
            name: 'codex',
            command: 'bun',
            args: [acpFixture],
            enabled: true,
            osSandbox: false,
            forwardMcp: true
          }
        })
      );
      expect(register.status).toBe(200);

      const session = await getSession(t, sessionId);
      const origin = {
        ...session.origin,
        ext: { ...(session.origin?.ext ?? {}), [CHANNEL_HOST_EXT_KEY]: `agent:${agent.id}` }
      };
      const hostRes = await t.fetch(`/v1/sessions/${sessionId}`, json('PATCH', { agentId: agent.id, origin }));
      expect(hostRes.status).toBe(200);
      modelReplies.push(
        JSON.stringify({
          display: { kind: 'markdown', content: 'Delegating MCP check.' },
          attachments: [],
          next: [{ agentId: 'acp:codex', prompt: 'mcp' }]
        })
      );

      const eventsP = t.sse(`/v1/sessions/${sessionId}/events`, {
        until: (event) =>
          event.type === 'agent.message' &&
          (event.payload as { agentName?: unknown; text?: unknown }).agentName === 'codex' &&
          typeof (event.payload as { text?: unknown }).text === 'string' &&
          (event.payload as { text: string }).text.includes('mcp: session-mcp'),
        timeoutMs: 3000
      });
      const send = await t.fetch(`/v1/channels/${sessionId}/messages`, json('POST', { text: 'check mcp forwarding' }));
      expect(send.status).toBe(200);

      const events = await eventsP;
      expect(
        events.some(
          (event: Event) =>
            event.type === 'agent.message' &&
            (event.payload as { agentName?: unknown; text?: unknown }).agentName === 'codex' &&
            typeof (event.payload as { text?: unknown }).text === 'string' &&
            (event.payload as { text: string }).text.includes('mcp: session-mcp')
        )
      ).toBe(true);
      clearAcpDelegatesForSession(sessionId as SessionId);
    });
  });
}
