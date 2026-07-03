import type { MonadPaths } from '@monad/home';
import type {
  Agent,
  Event,
  ProjectId,
  Session,
  SessionId,
  SessionUiEvent,
  UIMessageItem,
  UIPart,
  WorkplaceProject
} from '@monad/protocol';
import type { ModelChunk, ModelRequest, ModelRouter } from '@/agent/model/index.ts';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
const WORKPLACE_PROJECT_MEMBERS_EXT_KEY = 'workplaceProjectMembers';
const MANAGED_AGENT_TOKEN = 'managed-agent-token';
const TEST_NATIVE_CLI_SERVER_URL = 'http://127.0.0.1:61234';
const acpFixture = resolve(import.meta.dir, '../fixtures/mock-acp-agent.ts');

function makePaths(base: string): MonadPaths {
  return makeTestPaths(base);
}

const json = (method: string, body?: unknown, headers?: Record<string, string>): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', ...headers },
  body: body === undefined ? undefined : JSON.stringify(body)
});

async function createSession(t: TransportHandle, cwd?: string): Promise<SessionId> {
  const res = await t.fetch(
    '/v1/sessions',
    json('POST', {
      title: 'Control Room: routing',
      origin: { surface: 'web', client: 'control-room' },
      ...(cwd ? { cwd } : {})
    })
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { sessionId: SessionId }).sessionId;
}

async function getSession(t: TransportHandle, sessionId: string): Promise<Session> {
  const res = await t.fetch(`/v1/sessions/${sessionId}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { session: Session }).session;
}

async function createWorkplaceProject(t: TransportHandle, cwd?: string): Promise<ProjectId> {
  const res = await t.fetch(
    '/v1/workplace/projects',
    json('POST', {
      title: 'Workplace: routing',
      origin: { surface: 'web' },
      ...(cwd ? { cwd } : {})
    })
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { projectId: ProjectId }).projectId;
}

async function getWorkplaceProject(t: TransportHandle, projectId: string): Promise<WorkplaceProject> {
  const res = await t.fetch(`/v1/workplace/projects/${projectId}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { project: WorkplaceProject }).project;
}

async function updateWorkplaceProjectOrigin(
  t: TransportHandle,
  projectId: string,
  origin: unknown
): Promise<WorkplaceProject> {
  if (!origin) throw new Error('workplace project origin missing');
  const res = await t.fetch(`/v1/workplace/projects/${projectId}`, json('PATCH', { origin }));
  expect(res.status).toBe(200);
  return ((await res.json()) as { project: WorkplaceProject }).project;
}

async function createAgent(t: TransportHandle): Promise<Agent> {
  const res = await t.fetch('/v1/agents', json('POST', { name: 'Channel Host', prompt: 'Route channel messages.' }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { agent: Agent }).agent;
}

async function listMessages(t: TransportHandle, sessionId: string): Promise<Array<{ role: string; text: string }>> {
  const route = sessionId.startsWith('prj_') ? 'projects' : 'sessions';
  const listed = await t.fetch(`/v1/${route}/${sessionId}/messages`);
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

const tokenHash = (token = MANAGED_AGENT_TOKEN): string => createHash('sha256').update(token).digest('hex');

function managedBindingHeaders(sessionId: string, nativeCliSessionId: string, agentId: string): Record<string, string> {
  void sessionId;
  void agentId;
  return {
    authorization: `Bearer ${MANAGED_AGENT_TOKEN}`,
    'x-monad-native-cli-session-id': nativeCliSessionId
  };
}

async function configureMockNativeCliAgent(
  t: TransportHandle,
  root: string,
  opts: { agentName?: string; authState?: 'authenticated' | 'unauthenticated' | 'unknown' } = {}
): Promise<{ argsLog: string; envLog: string; stdinLog: string }> {
  const agentName = opts.agentName ?? 'codex';
  const script = join(root, `mock-native-cli-${agentName}.js`);
  const argsLog = join(root, `mock-native-cli-${agentName}-args.log`);
  const envLog = join(root, `mock-native-cli-${agentName}-env.jsonl`);
  const stdinLog = join(root, `mock-native-cli-${agentName}-stdin.log`);
  const command = process.platform === 'win32' ? process.execPath : script;
  const args = process.platform === 'win32' ? [script] : [];
  await writeFile(
    script,
    [
      '#!/usr/bin/env bun',
      'import { appendFileSync } from "node:fs";',
      `const argsLog = ${JSON.stringify(argsLog)};`,
      `const envLog = ${JSON.stringify(envLog)};`,
      `const stdinLog = ${JSON.stringify(stdinLog)};`,
      `const authState = ${JSON.stringify(opts.authState ?? 'authenticated')};`,
      'const args = process.argv.slice(2).join(" ");',
      'if (args === "login status" || args === "auth status" || args === "auth status --json") {',
      '  process.stdout.write(JSON.stringify({ state: authState }) + "\\n");',
      '  process.exit(0);',
      '}',
      'appendFileSync(argsLog, args + "\\n");',
      'appendFileSync(envLog, JSON.stringify({ MONAD_SERVER_URL: process.env.MONAD_SERVER_URL, CODEX_NON_INTERACTIVE: process.env.CODEX_NON_INTERACTIVE }) + "\\n");',
      'if (args.includes("app-server --stdio")) {',
      '  process.stdin.on("data", (d) => {',
      '    appendFileSync(stdinLog, d.toString());',
      '    for (const line of d.toString().trim().split(/\\n+/)) {',
      '      if (!line) continue;',
      '      const msg = JSON.parse(line);',
      '      if (msg.method === "thread/start") {',
      '        process.stdout.write(JSON.stringify({ id: msg.id, result: { thread: { id: "codex-thread-" + process.pid } } }) + "\\n");',
      '      }',
      '      if (msg.method === "thread/resume") {',
      '        process.stdout.write(JSON.stringify({ id: msg.id, result: { thread: { id: msg.params.threadId } } }) + "\\n");',
      '      }',
      '    }',
      '  });',
      '  setInterval(() => {}, 1000);',
      '} else {',
      '  process.stdout.write("native-ready\\n");',
      '  process.stdin.on("data", (d) => {',
      '    appendFileSync(stdinLog, d.toString());',
      '    process.stdout.write("native-echo:" + d.toString());',
      '  });',
      '  setInterval(() => {}, 1000);',
      '}'
    ].join('\n')
  );
  await chmod(script, 0o755);
  const res = await t.fetch(
    '/v1/settings/native-cli-agents',
    json('PUT', {
      agent: {
        name: agentName,
        provider: agentName === 'claude' || agentName === 'claude-code' ? 'claude-code' : 'codex',
        command,
        args,
        enabled: true,
        defaultLaunchMode: 'pty',
        allowDangerousMode: false,
        approvalOwnership: 'provider-owned'
      }
    })
  );
  expect(res.status).toBe(200);
  return { argsLog, envLog, stdinLog };
}

async function readLogIfExists(path: string): Promise<string> {
  return readFile(path, 'utf8').catch(() => '');
}

async function configureMockCodexResumeFailureAgent(t: TransportHandle, root: string): Promise<{ stdinLog: string }> {
  const script = join(root, 'mock-codex-resume-failure.js');
  const stdinLog = join(root, 'mock-codex-resume-failure-stdin.jsonl');
  await writeFile(
    script,
    [
      '#!/usr/bin/env bun',
      'import { appendFileSync } from "node:fs";',
      `const stdinLog = ${JSON.stringify(stdinLog)};`,
      'const args = process.argv.slice(2).join(" ");',
      'if (args === "login status") {',
      '  process.stdout.write(JSON.stringify({ state: "authenticated" }) + "\\n");',
      '  process.exit(0);',
      '}',
      'process.stdin.on("data", (d) => {',
      '  appendFileSync(stdinLog, d.toString());',
      '  for (const line of d.toString().trim().split(/\\n+/)) {',
      '    if (!line) continue;',
      '    const msg = JSON.parse(line);',
      '    if (msg.method === "thread/resume") {',
      '      process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: "resume missing" } }) + "\\n");',
      '    }',
      '    if (msg.method === "thread/start") {',
      '      process.stdout.write(JSON.stringify({ id: msg.id, result: { thread: { id: "codex-thread-fresh" } } }) + "\\n");',
      '    }',
      '    if (msg.method === "thread/turns/list") {',
      '      process.stdout.write(JSON.stringify({ id: msg.id, result: { data: [], nextCursor: null, backwardsCursor: null } }) + "\\n");',
      '    }',
      '  }',
      '});',
      'setInterval(() => {}, 1000);'
    ].join('\n')
  );
  await chmod(script, 0o755);
  const res = await t.fetch(
    '/v1/settings/native-cli-agents',
    json('PUT', {
      agent: {
        name: 'codex-resume-failure',
        provider: 'codex',
        command: script,
        args: [],
        enabled: true,
        defaultLaunchMode: 'app-server',
        allowDangerousMode: false,
        approvalOwnership: 'provider-owned'
      }
    })
  );
  expect(res.status).toBe(200);
  return { stdinLog };
}

async function configureMockCodexStartFailureAgent(t: TransportHandle, root: string): Promise<void> {
  const script = join(root, 'mock-codex-start-failure.js');
  await writeFile(
    script,
    [
      '#!/usr/bin/env bun',
      'const args = process.argv.slice(2).join(" ");',
      'if (args === "login status") {',
      '  process.stdout.write(JSON.stringify({ state: "authenticated" }) + "\\n");',
      '  process.exit(0);',
      '}',
      'process.stdin.on("data", (d) => {',
      '  for (const line of d.toString().trim().split(/\\n+/)) {',
      '    if (!line) continue;',
      '    const msg = JSON.parse(line);',
      '    if (msg.method === "thread/start") {',
      '      process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: "start failed" } }) + "\\n");',
      '    }',
      '  }',
      '});',
      'setInterval(() => {}, 1000);'
    ].join('\n')
  );
  await chmod(script, 0o755);
  const res = await t.fetch(
    '/v1/settings/native-cli-agents',
    json('PUT', {
      agent: {
        name: 'codex-start-failure',
        provider: 'codex',
        command: script,
        args: [],
        enabled: true,
        defaultLaunchMode: 'app-server',
        allowDangerousMode: false,
        approvalOwnership: 'provider-owned'
      }
    })
  );
  expect(res.status).toBe(200);
}

async function waitForFile(path: string, expected: string): Promise<string> {
  for (let i = 0; i < 120; i++) {
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
    let handlers: ReturnType<typeof buildHandlers>;

    beforeEach(async () => {
      modelRequests = [];
      modelReplies = [];
      dir = join(tmpdir(), `monad-channel-routing-${Date.now()}-${process.hrtime.bigint()}`);
      const paths = makePaths(dir);
      await initMonadHome(paths);
      const cfg = await loadConfig(paths.config);
      if (!cfg) throw new Error('config missing after init');
      const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry());
      handlers = buildHandlers(
        captureModel(modelRequests, modelReplies),
        { paths, modelService },
        {
          nativeCliServerUrl: TEST_NATIVE_CLI_SERVER_URL
        }
      );
      t = serveTransport(kind, createHttpTransport(handlers));
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
      const sessionId = await createWorkplaceProject(t);
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

    test('project workdir slash command updates the Workplace Project row, not a Monad session', async () => {
      const sessionId = await createWorkplaceProject(t);
      const projectDir = join(dir, 'project-command-workdir');
      await mkdir(projectDir, { recursive: true });

      const workdir = await t.fetch(
        `/v1/projects/${sessionId}/messages`,
        json('POST', { text: `/workdir ${projectDir}` })
      );
      expect(workdir.status).toBe(200);
      expect(handlers.store.getSession(sessionId)).toBeNull();
      expect(handlers.store.getWorkplaceProject(sessionId)?.cwd).toBe(projectDir);
    });

    test('Monad only generates for project messages when invited as a project member', async () => {
      modelReplies.push('monad member response');
      const session = await getWorkplaceProject(t, await createWorkplaceProject(t));
      const sessionId = session.id;
      const origin = {
        ...session.origin,
        ext: {
          ...(session.origin?.ext ?? {}),
          [WORKPLACE_PROJECT_MEMBERS_EXT_KEY]: [{ type: 'monad', name: 'monad' }]
        }
      };
      await updateWorkplaceProjectOrigin(t, sessionId, origin);

      const send = await t.fetch(`/v1/projects/${sessionId}/messages`, json('POST', { text: 'hello monad member' }));
      expect(send.status).toBe(200);
      expect(await send.json()).toEqual({ accepted: true });

      const messages = await waitForMessages(t, sessionId, 2);
      expect(messages.map((message) => [message.role, message.text])).toEqual([
        ['user', 'hello monad member'],
        ['assistant', 'monad member response']
      ]);
      expect(modelRequests).toHaveLength(1);
    });

    test('adding a managed native CLI project member starts only that member runtime', async () => {
      const projectDir = join(dir, 'project-add-member');
      await mkdir(projectDir, { recursive: true });
      const codex = await configureMockNativeCliAgent(t, dir, { agentName: 'codex' });
      const claude = await configureMockNativeCliAgent(t, dir, { agentName: 'claude-code' });
      const session = await getWorkplaceProject(t, await createWorkplaceProject(t, projectDir));
      const sessionId = session.id;
      const uiStartedP = t.sse(`/v1/projects/${sessionId}/ui-stream`, {
        until: (event) => {
          const uiEvent = event as unknown as SessionUiEvent;
          return (
            uiEvent.kind === 'upsert' &&
            uiEvent.item.kind === 'tool' &&
            uiEvent.item.id.startsWith('ncli_') &&
            (uiEvent.item.input as { agent?: unknown } | undefined)?.agent === 'codex'
          );
        },
        timeoutMs: 3000
      });
      const origin = {
        ...session.origin,
        ext: {
          ...(session.origin?.ext ?? {}),
          [WORKPLACE_PROJECT_MEMBERS_EXT_KEY]: [
            {
              type: 'native-cli',
              name: 'codex',
              settings: { launchMode: 'pty' }
            }
          ]
        }
      };

      await updateWorkplaceProjectOrigin(t, sessionId, origin);
      expect((await uiStartedP).some((event) => (event as unknown as SessionUiEvent).kind === 'upsert')).toBe(true);
      const snapshotEvents = await t.sse(`/v1/projects/${sessionId}/ui-stream`, {
        until: (event) => (event as unknown as SessionUiEvent).kind === 'snapshot',
        timeoutMs: 3000
      });
      const snapshot = (snapshotEvents as unknown as SessionUiEvent[]).find((event) => event.kind === 'snapshot');
      expect(
        snapshot?.kind === 'snapshot' &&
          snapshot.items.some(
            (item) =>
              item.kind === 'message' &&
              item.role === 'assistant' &&
              item.agentName === 'codex' &&
              item.status === 'streaming'
          )
      ).toBe(true);
      await waitForFile(codex.envLog, TEST_NATIVE_CLI_SERVER_URL);
      expect(await readLogIfExists(claude.envLog)).toBe('');

      const listed = await t.fetch(`/v1/projects/${sessionId}/native-cli-sessions`);
      expect(listed.status).toBe(200);
      const sessions = ((await listed.json()) as { sessions: Array<{ agentName: string }> }).sessions;
      expect(sessions.map((nativeSession) => nativeSession.agentName)).toEqual(['codex']);
    });

    test('project messages wake only native CLI members in the project roster', async () => {
      const projectDir = join(dir, 'project-roster-only');
      await mkdir(projectDir, { recursive: true });
      const codex = await configureMockNativeCliAgent(t, dir, { agentName: 'codex' });
      const claude = await configureMockNativeCliAgent(t, dir, { agentName: 'claude-code' });
      const session = await getWorkplaceProject(t, await createWorkplaceProject(t, projectDir));
      const sessionId = session.id;
      const origin = {
        ...session.origin,
        ext: {
          ...(session.origin?.ext ?? {}),
          [WORKPLACE_PROJECT_MEMBERS_EXT_KEY]: [
            {
              type: 'native-cli',
              name: 'codex',
              settings: { launchMode: 'pty' }
            }
          ]
        }
      };
      await updateWorkplaceProjectOrigin(t, sessionId, origin);

      const send = await t.fetch(`/v1/projects/${sessionId}/messages`, json('POST', { text: 'roster scoped task' }));
      expect(send.status).toBe(200);
      expect(await send.json()).toEqual({ accepted: true });
      const codexInput = await waitForFile(codex.stdinLog, 'roster scoped task');
      expect(codexInput).toContain('monad project post');
      await Bun.sleep(100);
      expect(await readLogIfExists(claude.argsLog)).toBe('');
      expect(await readLogIfExists(claude.stdinLog)).toBe('');
    });

    test('one native CLI template can be invited twice as isolated managed project agents', async () => {
      const projectDir = join(dir, 'project-template-instances');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockNativeCliAgent(t, dir, { agentName: 'codex' });
      const session = await getWorkplaceProject(t, await createWorkplaceProject(t, projectDir));
      const sessionId = session.id;
      const origin = {
        ...session.origin,
        ext: {
          ...(session.origin?.ext ?? {}),
          [WORKPLACE_PROJECT_MEMBERS_EXT_KEY]: [
            {
              type: 'native-cli',
              name: 'codex-reviewer',
              templateName: 'codex',
              displayName: 'codex-reviewer',
              instanceId: 'pmem_codex_reviewer',
              settings: { managedProjectAgent: true, launchMode: 'app-server' }
            },
            {
              type: 'native-cli',
              name: 'codex-tester',
              templateName: 'codex',
              displayName: 'codex-tester',
              instanceId: 'pmem_codex_tester',
              settings: { managedProjectAgent: true, launchMode: 'app-server' }
            }
          ]
        }
      };
      await updateWorkplaceProjectOrigin(t, sessionId, origin);

      const input = await waitForFile(stdinLog, '"method":"thread/start"');
      expect(input.split('"method":"thread/start"').length - 1).toBeGreaterThanOrEqual(2);
      const sessions = handlers.store
        .listNativeCliSessionsForTranscriptTarget(sessionId)
        .filter((candidate) => candidate.runtimeRole === 'managed-project-agent');
      expect(sessions.map((nativeSession) => nativeSession.agentName).sort()).toEqual([
        'pmem_codex_reviewer',
        'pmem_codex_tester'
      ]);
      expect(new Set(sessions.map((nativeSession) => nativeSession.workingPath))).toEqual(
        new Set([await realpath(projectDir)])
      );
      expect(
        new Set(
          sessions.map((nativeSession) =>
            join(makePaths(dir).home, 'workplace-agents', sessionId, nativeSession.agentName)
          )
        ).size
      ).toBe(2);
      for (const nativeSession of sessions) {
        await t.fetch(`/v1/native-cli-sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`, json('POST'));
      }
    });

    test('renaming a managed native CLI project member does not change its runtime identity', async () => {
      const projectDir = join(dir, 'project-member-rename');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockNativeCliAgent(t, dir, { agentName: 'codex' });
      const session = await getWorkplaceProject(t, await createWorkplaceProject(t, projectDir));
      const sessionId = session.id;
      const origin = {
        ...session.origin,
        ext: {
          ...(session.origin?.ext ?? {}),
          [WORKPLACE_PROJECT_MEMBERS_EXT_KEY]: [
            {
              type: 'native-cli',
              name: 'codex-reviewer',
              templateName: 'codex',
              displayName: 'Reviewer',
              instanceId: 'pmem_codex_reviewer',
              settings: { managedProjectAgent: true, launchMode: 'pty' }
            }
          ]
        }
      };
      await updateWorkplaceProjectOrigin(t, sessionId, origin);
      await waitForFile(stdinLog, 'You are a Monad-managed native CLI agent participating in a Workplace Project.');

      const renamed = {
        ...origin,
        ext: {
          ...origin.ext,
          [WORKPLACE_PROJECT_MEMBERS_EXT_KEY]: [
            {
              type: 'native-cli',
              name: 'codex-reviewer',
              templateName: 'codex',
              displayName: 'Renamed reviewer',
              instanceId: 'pmem_codex_reviewer',
              settings: { managedProjectAgent: true, launchMode: 'pty' }
            }
          ]
        }
      };
      await updateWorkplaceProjectOrigin(t, sessionId, renamed);

      const send = await t.fetch(`/v1/projects/${sessionId}/messages`, json('POST', { text: 'after rename task' }));
      expect(send.status).toBe(200);
      const input = await waitForFile(stdinLog, 'after rename task');
      expect(input).toContain('Your display name: Renamed reviewer');
      expect(input).toContain('Your runtime agent id: pmem_codex_reviewer');
      expect(input).toContain('Provider: codex');

      const sessions = handlers.store
        .listNativeCliSessionsForTranscriptTarget(sessionId)
        .filter((candidate) => candidate.runtimeRole === 'managed-project-agent');
      expect(sessions.map((nativeSession) => nativeSession.agentName)).toEqual(['pmem_codex_reviewer']);
      for (const nativeSession of sessions) {
        await t.fetch(`/v1/native-cli-sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`, json('POST'));
      }
    });

    test('managed native CLI project member is started and receives an inbox notice for public project messages', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { envLog, stdinLog } = await configureMockNativeCliAgent(t, dir);
      const session = await getWorkplaceProject(t, await createWorkplaceProject(t, projectDir));
      const sessionId = session.id;
      const origin = {
        ...session.origin,
        ext: {
          ...(session.origin?.ext ?? {}),
          [WORKPLACE_PROJECT_MEMBERS_EXT_KEY]: [
            {
              type: 'native-cli',
              name: 'codex',
              settings: { launchMode: 'pty' }
            }
          ]
        }
      };
      await updateWorkplaceProjectOrigin(t, sessionId, origin);

      const send = await t.fetch(`/v1/projects/${sessionId}/messages`, json('POST', { text: 'please review this' }));
      expect(send.status).toBe(200);
      expect(await send.json()).toEqual({ accepted: true });
      const snapshotEvents = await t.sse(`/v1/projects/${sessionId}/ui-stream`, {
        until: (event) => (event as unknown as SessionUiEvent).kind === 'snapshot',
        timeoutMs: 3000
      });
      const snapshot = (snapshotEvents as unknown as SessionUiEvent[]).find((event) => event.kind === 'snapshot');
      expect(
        snapshot?.kind === 'snapshot'
          ? snapshot.items.filter(
              (item) => item.kind === 'message' && item.agentName === 'codex' && item.status === 'streaming'
            ).length
          : 0
      ).toBe(1);

      const input = await waitForFile(stdinLog, 'monad project inbox check');
      expect(input).toContain('Process this project message now.');
      expect(input).toContain('Sender kind: human');
      expect(input).toContain('Sender name:');
      expect(input).toContain('Sender mention token:');
      expect(input).toContain('human');
      expect(input).toContain('please review this');
      expect(input).toContain('monad project post');
      expect(input).toContain('first acknowledge ownership');
      expect(input).toContain('strict capsule token');
      expect(input).toContain('display name');
      const envText = await waitForFile(envLog, TEST_NATIVE_CLI_SERVER_URL);
      expect(JSON.parse(envText.trim().split(/\n/).at(-1) ?? '{}')).toMatchObject({
        MONAD_SERVER_URL: TEST_NATIVE_CLI_SERVER_URL
      });
      const messages = await waitForMessages(t, sessionId, 2);
      expect(messages.filter((message) => message.text).map((message) => [message.role, message.text])).toEqual([
        ['user', 'please review this']
      ]);
      const listed = await t.fetch(`/v1/projects/${sessionId}/native-cli-sessions`);
      expect(listed.status).toBe(200);
      const [nativeSession] = (
        (await listed.json()) as {
          sessions: Array<{
            id: string;
            agentName: string;
            runtimeRole: string;
            lastDeliveredSeq: number;
            lastVisibleSeq: number;
            workingPath: string;
          }>;
        }
      ).sessions;
      expect(nativeSession?.runtimeRole).toBe('managed-project-agent');
      expect(nativeSession?.lastDeliveredSeq).toBeGreaterThan(0);
      expect(nativeSession?.lastVisibleSeq).toBe(nativeSession?.lastDeliveredSeq);
      if (!nativeSession) throw new Error('managed native CLI session was not started');
      expect(handlers.store.listNativeCliInbox(nativeSession.id)).toEqual([]);
      expect(nativeSession.workingPath).toBe(await realpath(projectDir));
      const agentWorkspace = join(makePaths(dir).home, 'workplace-agents', sessionId, nativeSession.agentName);
      expect(await readFile(join(agentWorkspace, '.monad-agent-token'), 'utf8')).not.toBe('');
      await t.fetch(`/v1/native-cli-sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`, json('POST'));
      expect(await readFile(join(agentWorkspace, '.monad-agent-token'), 'utf8').catch(() => null)).toBeNull();
      expect(await readFile(join(agentWorkspace, 'MEMORY.md'), 'utf8')).toContain('managed project memory');
    });

    test('running managed native CLI member receives a busy inbox notice without the full project message body', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockNativeCliAgent(t, dir);
      const session = await getWorkplaceProject(t, await createWorkplaceProject(t, projectDir));
      const sessionId = session.id;
      const origin = {
        ...session.origin,
        ext: {
          ...(session.origin?.ext ?? {}),
          [WORKPLACE_PROJECT_MEMBERS_EXT_KEY]: [
            {
              type: 'native-cli',
              name: 'codex',
              settings: { managedProjectAgent: true, launchMode: 'pty' }
            }
          ]
        }
      };
      await updateWorkplaceProjectOrigin(t, sessionId, origin);

      const first = await t.fetch(`/v1/projects/${sessionId}/messages`, json('POST', { text: 'first project task' }));
      expect(first.status).toBe(200);
      await waitForFile(stdinLog, 'first project task');

      const second = await t.fetch(
        `/v1/projects/${sessionId}/messages`,
        json('POST', { text: 'second secret busy task' })
      );
      expect(second.status).toBe(200);
      const input = await waitForFile(stdinLog, 'You are being woken to process the pending project inbox now.');
      expect(input).toContain('first project task');
      expect(input).not.toContain('second secret busy task');
      expect(input).toContain('New Workplace Project message is available.');
      expect(input).toContain('You are being woken to process the pending project inbox now.');
      expect(input).toContain('If a public response is appropriate, post it with `monad project post -` and stdin.');
      expect(input).toContain('Do not pass message text inline in a shell command');

      const third = await t.fetch(
        `/v1/projects/${sessionId}/messages`,
        json('POST', { text: 'third secret busy task' })
      );
      expect(third.status).toBe(200);
      await Bun.sleep(100);
      const afterThird = await readFile(stdinLog, 'utf8');
      expect(afterThird.split('You are being woken to process the pending project inbox now.').length - 1).toBe(1);
      expect(afterThird).not.toContain('third secret busy task');

      const [nativeSession] = handlers.store.listNativeCliSessionsForTranscriptTarget(sessionId);
      if (nativeSession) {
        expect(
          handlers.store.listNativeCliInbox(nativeSession.id).map((item) => [item.deliveryState, item.message.text])
        ).toEqual([
          ['delivered', 'second secret busy task'],
          ['delivered', 'third secret busy task']
        ]);
      }
      if (nativeSession)
        await t.fetch(`/v1/native-cli-sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`, json('POST'));
    });

    test('managed native CLI project member resumes a stored provider session ref', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { argsLog } = await configureMockNativeCliAgent(t, dir, { agentName: 'claude' });
      const session = await getWorkplaceProject(t, await createWorkplaceProject(t, projectDir));
      const sessionId = session.id;
      handlers.store.upsertNativeCliSession({
        id: 'ncli_old_claude',
        transcriptTargetId: sessionId,
        agentName: 'claude',
        provider: 'claude-code',
        workingPath: projectDir,
        launchMode: 'pty',
        runtimeRole: 'managed-project-agent',
        agentRuntimeId: 'ncli_old_claude',
        agentRuntimeTokenHash: tokenHash(),
        lastDeliveredSeq: 0,
        lastVisibleSeq: 0,
        state: 'stopped',
        pid: null,
        providerSessionRef: 'claude-session-resume',
        outputSnapshot: '',
        exitCode: null,
        startedAt: '2026-06-30T00:00:00.000Z',
        updatedAt: '2026-06-30T00:00:01.000Z',
        exitedAt: '2026-06-30T00:00:01.000Z'
      });
      const origin = {
        ...session.origin,
        ext: {
          ...(session.origin?.ext ?? {}),
          [WORKPLACE_PROJECT_MEMBERS_EXT_KEY]: [
            {
              type: 'native-cli',
              name: 'claude',
              settings: { managedProjectAgent: true, launchMode: 'pty' }
            }
          ]
        }
      };
      await updateWorkplaceProjectOrigin(t, sessionId, origin);

      const send = await t.fetch(`/v1/projects/${sessionId}/messages`, json('POST', { text: 'resume this task' }));
      expect(send.status).toBe(200);

      const args = await waitForFile(argsLog, '--resume claude-session-resume');
      expect(args).toContain('--append-system-prompt-file');
      const resumed = handlers.store
        .listNativeCliSessionsForTranscriptTarget(sessionId)
        .find((candidate) => candidate.agentName === 'claude' && candidate.state === 'running');
      expect(resumed?.providerSessionRef).toBe('claude-session-resume');
      if (resumed)
        await t.fetch(`/v1/native-cli-sessions/${resumed.id}/stop?transcriptTargetId=${sessionId}`, json('POST'));
    });

    test('managed native CLI project member falls back to a cold start when provider resume fails', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockCodexResumeFailureAgent(t, dir);
      const session = await getWorkplaceProject(t, await createWorkplaceProject(t, projectDir));
      const sessionId = session.id;
      handlers.store.upsertNativeCliSession({
        id: 'ncli_old_codex',
        transcriptTargetId: sessionId,
        agentName: 'codex-resume-failure',
        provider: 'codex',
        workingPath: projectDir,
        launchMode: 'app-server',
        runtimeRole: 'managed-project-agent',
        agentRuntimeId: 'ncli_old_codex',
        agentRuntimeTokenHash: tokenHash(),
        lastDeliveredSeq: 0,
        lastVisibleSeq: 0,
        state: 'stopped',
        pid: null,
        providerSessionRef: 'codex-thread-stale',
        outputSnapshot: '',
        exitCode: null,
        startedAt: '2026-06-30T00:00:00.000Z',
        updatedAt: '2026-06-30T00:00:01.000Z',
        exitedAt: '2026-06-30T00:00:01.000Z'
      });
      const origin = {
        ...session.origin,
        ext: {
          ...(session.origin?.ext ?? {}),
          [WORKPLACE_PROJECT_MEMBERS_EXT_KEY]: [
            {
              type: 'native-cli',
              name: 'codex-resume-failure',
              settings: { managedProjectAgent: true, launchMode: 'app-server' }
            }
          ]
        }
      };
      await updateWorkplaceProjectOrigin(t, sessionId, origin);

      const resumeFailedP = t.sse(`/v1/projects/${sessionId}/events`, {
        until: (event) => event.type === 'native_cli.resume_failed',
        timeoutMs: 3000
      });
      const send = await t.fetch(
        `/v1/projects/${sessionId}/messages`,
        json('POST', { text: 'recover from stale resume' })
      );
      expect(send.status).toBe(200);
      const resumeFailed = await resumeFailedP;
      expect(resumeFailed.at(-1)?.payload).toMatchObject({
        agentName: 'codex-resume-failure',
        providerSessionRef: 'codex-thread-stale'
      });

      const rpc = await waitForFile(stdinLog, '"method":"thread/start"');
      expect(rpc).toContain('"method":"thread/resume"');
      expect(rpc).toContain('"threadId":"codex-thread-stale"');
      const coldStarted = handlers.store
        .listNativeCliSessionsForTranscriptTarget(sessionId)
        .find((candidate) => candidate.agentName === 'codex-resume-failure' && candidate.state === 'running');
      expect(coldStarted?.providerSessionRef).toBe('codex-thread-fresh');
      expect(handlers.store.getNativeCliSession('ncli_old_codex')?.providerSessionRef).toBeNull();
      if (coldStarted)
        await t.fetch(`/v1/native-cli-sessions/${coldStarted.id}/stop?transcriptTargetId=${sessionId}`, json('POST'));
    });

    test('managed native CLI project member start failures are written to the project transcript', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      await configureMockCodexStartFailureAgent(t, dir);
      const session = await getWorkplaceProject(t, await createWorkplaceProject(t, projectDir));
      const sessionId = session.id;
      const origin = {
        ...session.origin,
        ext: {
          ...(session.origin?.ext ?? {}),
          [WORKPLACE_PROJECT_MEMBERS_EXT_KEY]: [
            {
              type: 'native-cli',
              name: 'codex-start-failure',
              settings: { managedProjectAgent: true, launchMode: 'app-server' }
            }
          ]
        }
      };

      await updateWorkplaceProjectOrigin(t, sessionId, origin);

      const messages = await waitForMessages(t, sessionId, 1);
      expect(messages.map((message) => [message.role, message.text])).toEqual([
        ['assistant', 'codex-start-failure failed to join the project: start failed']
      ]);
    });

    test('managed native CLI project member requires Studio reconnect when provider auth is unauthenticated', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockNativeCliAgent(t, dir, { authState: 'unauthenticated' });
      const session = await getWorkplaceProject(t, await createWorkplaceProject(t, projectDir));
      const sessionId = session.id;
      const origin = {
        ...session.origin,
        ext: {
          ...(session.origin?.ext ?? {}),
          [WORKPLACE_PROJECT_MEMBERS_EXT_KEY]: [
            {
              type: 'native-cli',
              name: 'codex',
              settings: { managedProjectAgent: true, launchMode: 'pty' }
            }
          ]
        }
      };
      await updateWorkplaceProjectOrigin(t, sessionId, origin);

      const eventsP = t.sse(`/v1/projects/${sessionId}/events`, {
        until: (event) => event.type === 'native_cli.connection_required',
        timeoutMs: 3000
      });
      const send = await t.fetch(`/v1/projects/${sessionId}/messages`, json('POST', { text: 'please review this' }));
      expect(send.status).toBe(200);
      expect(await send.json()).toEqual({ accepted: true });

      const events = await eventsP;
      expect(events.at(-1)?.payload).toMatchObject({
        agentName: 'codex',
        provider: 'codex',
        reconnectIn: 'studio'
      });
      expect(await readFile(stdinLog, 'utf8').catch(() => '')).toBe('');
      const messages = await waitForMessages(t, sessionId, 1);
      expect(messages[0]?.text).toBe('please review this');
      const listed = await t.fetch(`/v1/projects/${sessionId}/native-cli-sessions`);
      expect(listed.status).toBe(200);
      expect(((await listed.json()) as { sessions: unknown[] }).sessions).toEqual([]);
    });

    test('managed native CLI project post fans out to other managed native CLI members', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog: codexStdinLog } = await configureMockNativeCliAgent(t, dir, { agentName: 'codex' });
      const { stdinLog: claudeStdinLog } = await configureMockNativeCliAgent(t, dir, { agentName: 'claude' });
      const session = await getWorkplaceProject(t, await createWorkplaceProject(t, projectDir));
      const sessionId = session.id;
      const origin = {
        ...session.origin,
        ext: {
          ...(session.origin?.ext ?? {}),
          [WORKPLACE_PROJECT_MEMBERS_EXT_KEY]: [
            {
              type: 'native-cli',
              name: 'codex',
              settings: { managedProjectAgent: true, launchMode: 'pty' }
            },
            {
              type: 'native-cli',
              name: 'claude',
              settings: { managedProjectAgent: true, launchMode: 'pty' }
            }
          ]
        }
      };
      await updateWorkplaceProjectOrigin(t, sessionId, origin);

      const send = await t.fetch(`/v1/projects/${sessionId}/messages`, json('POST', { text: 'initial project task' }));
      expect(send.status).toBe(200);
      await waitForFile(codexStdinLog, 'initial project task');
      await waitForFile(claudeStdinLog, 'initial project task');

      const nativeSessions = handlers.store.listNativeCliSessionsForTranscriptTarget(sessionId);
      const codexSession = nativeSessions.find((candidate) => candidate.agentName === 'codex');
      expect(typeof codexSession?.id).toBe('string');
      if (!codexSession) throw new Error('codex managed native CLI session was not started');
      handlers.store.upsertNativeCliSession({ ...codexSession, agentRuntimeTokenHash: tokenHash() });

      const post = await t.fetch(
        '/v1/internal/native-agent/project/post',
        json(
          'POST',
          { projectId: sessionId, text: 'codex public reply' },
          managedBindingHeaders(sessionId, codexSession.id, 'codex')
        )
      );
      if (post.status !== 200) throw new Error(await post.text());
      expect(post.status).toBe(200);

      const claudeInput = await waitForFile(claudeStdinLog, 'codex public reply');
      expect(claudeInput).toContain('monad project inbox check');
      expect(claudeInput).toContain('Sender kind: native-cli-agent');
      expect(claudeInput).toContain('Sender name: codex');
      expect(claudeInput).toContain('Sender mention token:');
      expect(claudeInput).toContain('native-cli:codex');
      const transcriptMessages = handlers.store
        .listMessages(sessionId, { latest: true })
        .filter((message) => message.text)
        .map((message) => [message.role, message.text]);
      expect(transcriptMessages).toEqual(
        expect.arrayContaining([
          ['user', 'initial project task'],
          ['assistant', 'codex public reply']
        ])
      );
      const direct = await t.fetch(
        '/v1/internal/native-agent/agent/send',
        json(
          'POST',
          { to: 'claude', text: 'codex private note' },
          managedBindingHeaders(sessionId, codexSession.id, 'codex')
        )
      );
      if (direct.status !== 200) throw new Error(await direct.text());
      expect(direct.status).toBe(200);

      const directNotice = await waitForFile(claudeStdinLog, 'codex private note');
      expect(directNotice).toContain('New direct/private message from codex is available.');
      expect(directNotice).toContain('monad agent read --with codex');
      expect(handlers.store.listMessages(sessionId, { latest: true }).filter((message) => message.text)).toHaveLength(
        2
      );
      for (const nativeSession of nativeSessions) {
        await t.fetch(`/v1/native-cli-sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`, json('POST'));
      }
    });

    test('native CLI mention forwards input to the provider-owned CLI session through the project route', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockNativeCliAgent(t, dir);
      const session = await getWorkplaceProject(t, await createWorkplaceProject(t, projectDir));
      const sessionId = session.id;
      await updateWorkplaceProjectOrigin(t, sessionId, {
        ...session.origin,
        ext: {
          ...(session.origin?.ext ?? {}),
          [WORKPLACE_PROJECT_MEMBERS_EXT_KEY]: [
            { type: 'native-cli', name: 'codex', settings: { managedProjectAgent: false, launchMode: 'pty' } }
          ]
        }
      });

      const eventsP = t.sse(`/v1/projects/${sessionId}/events`, {
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
      const listed = await t.fetch(`/v1/projects/${sessionId}/native-cli-sessions`);
      expect(listed.status).toBe(200);
      const nativeSessionId = ((await listed.json()) as { sessions: Array<{ id: string }> }).sessions[0]?.id;
      expect(typeof nativeSessionId).toBe('string');
      await t.fetch(`/v1/native-cli-sessions/${nativeSessionId}/stop?transcriptTargetId=${sessionId}`, json('POST'));
    });

    test('native CLI mention requires Studio reconnect when provider auth status is unauthenticated', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockNativeCliAgent(t, dir, { authState: 'unauthenticated' });
      const session = await getWorkplaceProject(t, await createWorkplaceProject(t, projectDir));
      const sessionId = session.id;
      await updateWorkplaceProjectOrigin(t, sessionId, {
        ...session.origin,
        ext: {
          ...(session.origin?.ext ?? {}),
          [WORKPLACE_PROJECT_MEMBERS_EXT_KEY]: [
            { type: 'native-cli', name: 'codex', settings: { managedProjectAgent: false, launchMode: 'pty' } }
          ]
        }
      });

      const eventsP = t.sse(`/v1/projects/${sessionId}/events`, {
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
      const session = await getWorkplaceProject(t, await createWorkplaceProject(t, projectDir));
      const sessionId = session.id;
      await updateWorkplaceProjectOrigin(t, sessionId, {
        ...session.origin,
        ext: {
          ...(session.origin?.ext ?? {}),
          [WORKPLACE_PROJECT_MEMBERS_EXT_KEY]: [
            { type: 'native-cli', name: 'codex', settings: { managedProjectAgent: false, launchMode: 'pty' } }
          ]
        }
      });

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
      const session = await getWorkplaceProject(t, await createWorkplaceProject(t));
      const sessionId = session.id;
      await updateWorkplaceProjectOrigin(t, sessionId, {
        ...session.origin,
        ext: {
          ...(session.origin?.ext ?? {}),
          [WORKPLACE_PROJECT_MEMBERS_EXT_KEY]: [
            { type: 'native-cli', name: 'codex', settings: { managedProjectAgent: false, launchMode: 'pty' } }
          ]
        }
      });
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
