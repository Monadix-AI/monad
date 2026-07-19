import type { MonadPaths } from '@monad/environment';
import type {
  ProjectId,
  Session,
  SessionId,
  SessionUiEvent,
  UIMessageItem,
  UIPart,
  WorkplaceProject,
  WorkplaceProjectMemberSettings,
  WorkplaceProjectMemberTemplate,
  WorkplaceProjectSessionMember
} from '@monad/protocol';
import type { ModelChunk, ModelRequest, ModelRouter } from '#/agent/model/index.ts';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome, loadAuth, loadConfig } from '@monad/environment';

import { ModelService } from '#/handlers/settings/model/index.ts';
import { createHttpTransport } from '#/transports/http.ts';
import {
  buildHandlers,
  makeTestPaths,
  seededProviderRegistry,
  serveTransport,
  TRANSPORTS,
  type TransportHandle
} from '../helpers.ts';

const MANAGED_AGENT_TOKEN = 'managed-agent-token';
const TEST_MESH_AGENT_SERVER_URL = 'http://127.0.0.1:61234';

function makePaths(base: string): MonadPaths {
  return makeTestPaths(base);
}

const json = (method: string, body?: unknown, headers?: Record<string, string>): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', ...headers },
  body: body === undefined ? undefined : JSON.stringify(body)
});

async function _createSession(t: TransportHandle, cwd?: string): Promise<SessionId> {
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

async function _getSession(t: TransportHandle, sessionId: string): Promise<Session> {
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

async function _getWorkplaceProject(t: TransportHandle, projectId: string): Promise<WorkplaceProject> {
  const res = await t.fetch(`/v1/workplace/projects/${projectId}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { project: WorkplaceProject }).project;
}

async function updateWorkplaceProjectCwd(
  t: TransportHandle,
  projectId: string,
  cwd: string
): Promise<WorkplaceProject> {
  const res = await t.fetch(`/v1/workplace/projects/${projectId}`, json('PATCH', { cwd }));
  expect(res.status).toBe(200);
  return ((await res.json()) as { project: WorkplaceProject }).project;
}

/** Track B: create a real Session under a Workplace Project. Its id is the conversation id used for
 *  channel messages, events, ui-stream, mesh-sessions, and the mesh-agent transcript
 *  target — the project is only the environment, not the conversation. */
async function createProjectSession(t: TransportHandle, projectId: string, cwd?: string): Promise<SessionId> {
  const res = await t.fetch(
    `/v1/projects/${projectId}/sessions`,
    json('POST', {
      title: 'Workplace: routing',
      origin: { surface: 'web' },
      ...(cwd ? { cwd } : {})
    })
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { sessionId: SessionId }).sessionId;
}

/** Track B: set the project-level memberTemplates catalog (config only — nothing runs yet). */
async function setMemberTemplates(
  t: TransportHandle,
  projectId: string,
  memberTemplates: WorkplaceProjectMemberTemplate[]
): Promise<WorkplaceProject> {
  const res = await t.fetch(`/v1/workplace/projects/${projectId}`, json('PATCH', { memberTemplates }));
  expect(res.status).toBe(200);
  return ((await res.json()) as { project: WorkplaceProject }).project;
}

/** Track B: ensure a template has a live session binding. Project reconciliation may have already
 *  invited it; an explicit invite still starts it when the binding is absent. */
async function inviteMember(
  t: TransportHandle,
  sessionId: string,
  templateId: string
): Promise<WorkplaceProjectSessionMember> {
  const res = await t.fetch(`/v1/sessions/${sessionId}/members`, json('POST', { templateId }));
  if (res.status === 201) return ((await res.json()) as { member: WorkplaceProjectSessionMember }).member;

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: `member already invited into this session: ${templateId}`,
    code: 'VALIDATION'
  });
  const listed = await t.fetch(`/v1/sessions/${sessionId}/members`);
  expect(listed.status).toBe(200);
  const members = ((await listed.json()) as { members: WorkplaceProjectSessionMember[] }).members;
  const existing = members.find((member) => member.templateId === templateId);
  if (!existing) throw new Error(`reconciled member is missing from the session: ${templateId}`);
  return existing;
}

/** Build a managed mesh-agent member template. `id` becomes the runtime agent id (agentName);
 *  `name` selects the registered mesh-agent config that backs it. Reproduces the pre-Track-B
 *  origin.ext member roster entries with matching runtime identity. */
function meshAgentTemplate(
  id: string,
  configName: string,
  settings: WorkplaceProjectMemberSettings,
  displayName?: string
): WorkplaceProjectMemberTemplate {
  return {
    id,
    type: 'mesh-agent',
    name: configName,
    ...(displayName ? { displayName } : {}),
    settings
  };
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

const tokenHash = (token = MANAGED_AGENT_TOKEN): string => createHash('sha256').update(token).digest('hex');

function managedBindingHeaders(sessionId: string, meshSessionId: string, agentId: string): Record<string, string> {
  void sessionId;
  void agentId;
  return {
    authorization: `Bearer ${MANAGED_AGENT_TOKEN}`,
    'x-monad-mesh-session-id': meshSessionId
  };
}

async function configureMockMeshAgent(
  t: TransportHandle,
  root: string,
  opts: { agentName?: string; authState?: 'authenticated' | 'unauthenticated' | 'unknown' } = {}
): Promise<{ argsLog: string; envLog: string; stdinLog: string }> {
  const agentName = opts.agentName ?? 'codex';
  const script = join(root, `mock-mesh-agent-${agentName}.js`);
  const argsLog = join(root, `mock-mesh-agent-${agentName}-args.log`);
  const envLog = join(root, `mock-mesh-agent-${agentName}-env.jsonl`);
  const stdinLog = join(root, `mock-mesh-agent-${agentName}-stdin.log`);
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
      '      if (msg.method === "initialize") {',
      '        process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n");',
      '      }',
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
    `/v1/mesh/agents/${agentName}`,
    json('PUT', {
      agent: {
        name: agentName,
        provider: agentName === 'claude' || agentName === 'claude-code' ? 'claude-code' : 'codex',
        command,
        args,
        enabled: true,
        defaultLaunchMode: 'pty',
        allowAutopilot: false,
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
      '    if (msg.method === "initialize") {',
      '      process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n");',
      '    }',
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
    '/v1/mesh/agents/codex-resume-failure',
    json('PUT', {
      agent: {
        name: 'codex-resume-failure',
        provider: 'codex',
        command: script,
        args: [],
        enabled: true,
        defaultLaunchMode: 'app-server',
        allowAutopilot: false,
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
      '    if (msg.method === "initialize") {',
      '      process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n");',
      '    }',
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
    '/v1/mesh/agents/codex-start-failure',
    json('PUT', {
      agent: {
        name: 'codex-start-failure',
        provider: 'codex',
        command: script,
        args: [],
        enabled: true,
        defaultLaunchMode: 'app-server',
        allowAutopilot: false,
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
  // Returning the file instead of throwing lets an expectation that can never be satisfied pass on
  // unrelated earlier content, at the cost of a silent 3s stall on every such call.
  throw new Error(`timed out waiting for ${JSON.stringify(expected)} in ${path}`);
}

async function waitForValue<T>(read: () => T | undefined, label: string): Promise<T> {
  for (let i = 0; i < 120; i++) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function _uiMessageText(item: UIMessageItem): string {
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
      const cfg = await loadConfig(paths);
      if (!cfg) throw new Error('config missing after init');
      const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry());
      handlers = buildHandlers(
        captureModel(modelRequests, modelReplies),
        { paths, modelService },
        {
          meshAgentServerUrl: TEST_MESH_AGENT_SERVER_URL
        }
      );
      t = serveTransport(kind, createHttpTransport(handlers));
    });

    afterEach(async () => {
      await t.stop();
      await rm(dir, { recursive: true, force: true });
    });

    test('no-host project message records timeline only through the channel route', async () => {
      const projectId = await createWorkplaceProject(t);
      const sessionId = await createProjectSession(t, projectId);
      const oldRoute = await t.fetch(
        `/v1/sessions/${sessionId}/room/messages`,
        json('POST', { text: 'timeline only' })
      );
      expect(oldRoute.status).toBe(404);

      const send = await t.fetch(`/v1/channels/${sessionId}/messages`, json('POST', { text: 'timeline only' }));
      expect(send.status).toBe(200);
      expect(send.headers.get('content-type')).toContain('application/json');
      expect(await send.json()).toEqual({ accepted: true });

      await Bun.sleep(50);
      const messages = await listMessages(t, sessionId);
      expect(messages.map((message) => [message.role, message.text])).toEqual([['user', 'timeline only']]);
      expect(modelRequests).toEqual([]);
    });

    test('project workdir slash command updates the project session, not the Workplace Project row', async () => {
      const projectId = await createWorkplaceProject(t);
      const sessionId = await createProjectSession(t, projectId);
      const projectDir = join(dir, 'project-command-workdir');
      await mkdir(projectDir, { recursive: true });

      const workdir = await t.fetch(
        `/v1/channels/${sessionId}/messages`,
        json('POST', { text: `/workdir ${projectDir}` })
      );
      expect(workdir.status).toBe(200);
      await Bun.sleep(50);
      expect(handlers.store.getSession(sessionId)?.cwd).toBe(projectDir);
      expect(handlers.store.getWorkplaceProject(projectId)?.cwd ?? null).toBeNull();
      expect(modelRequests).toEqual([]);
    });

    test('Monad only generates for project messages when invited as a project member', async () => {
      modelReplies.push('monad member response');
      const projectId = await createWorkplaceProject(t);
      const sessionId = await createProjectSession(t, projectId);
      await setMemberTemplates(t, projectId, [{ id: 'monad', type: 'monad', name: 'monad' }]);
      await inviteMember(t, sessionId, 'monad');

      const send = await t.fetch(`/v1/channels/${sessionId}/messages`, json('POST', { text: 'hello monad member' }));
      expect(send.status).toBe(200);
      expect(await send.json()).toEqual({ accepted: true });

      const messages = await waitForMessages(t, sessionId, 2);
      expect(messages.map((message) => [message.role, message.text])).toEqual([
        ['user', 'hello monad member'],
        ['assistant', 'monad member response']
      ]);
      expect(modelRequests).toHaveLength(1);
    });

    test('inviting a managed MeshAgent project member starts only that member runtime', async () => {
      const projectDir = join(dir, 'project-add-member');
      await mkdir(projectDir, { recursive: true });
      const codex = await configureMockMeshAgent(t, dir, { agentName: 'codex' });
      const claude = await configureMockMeshAgent(t, dir, { agentName: 'claude-code' });
      const projectId = await createWorkplaceProject(t, projectDir);
      const sessionId = await createProjectSession(t, projectId, projectDir);
      const uiStartedP = t.sse(`/v1/sessions/${sessionId}/ui-stream`, {
        until: (event) => {
          const uiEvent = event as unknown as SessionUiEvent;
          return (
            uiEvent.kind === 'upsert' &&
            uiEvent.item.kind === 'tool' &&
            uiEvent.item.id.startsWith('mesh_') &&
            (uiEvent.item.input as { agent?: unknown } | undefined)?.agent === 'codex'
          );
        },
        timeoutMs: 3000
      });

      await setMemberTemplates(t, projectId, [meshAgentTemplate('codex', 'codex', { launchMode: 'pty' })]);
      await inviteMember(t, sessionId, 'codex');
      expect((await uiStartedP).some((event) => (event as unknown as SessionUiEvent).kind === 'upsert')).toBe(true);
      const snapshotEvents = await t.sse(`/v1/sessions/${sessionId}/ui-stream`, {
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
      await waitForFile(codex.envLog, TEST_MESH_AGENT_SERVER_URL);
      expect(await readLogIfExists(claude.envLog)).toBe('');

      const listed = await t.fetch(`/v1/mesh/sessions?transcriptTargetId=${sessionId}`);
      expect(listed.status).toBe(200);
      const sessions = ((await listed.json()) as { sessions: Array<{ agentName: string }> }).sessions;
      expect(sessions.map((nativeSession) => nativeSession.agentName)).toEqual(['codex']);
    });

    test('project messages wake only MeshAgent members in the project roster', async () => {
      const projectDir = join(dir, 'project-roster-only');
      await mkdir(projectDir, { recursive: true });
      const codex = await configureMockMeshAgent(t, dir, { agentName: 'codex' });
      const claude = await configureMockMeshAgent(t, dir, { agentName: 'claude-code' });
      const projectId = await createWorkplaceProject(t, projectDir);
      const sessionId = await createProjectSession(t, projectId, projectDir);
      await setMemberTemplates(t, projectId, [meshAgentTemplate('codex', 'codex', { launchMode: 'pty' })]);
      await inviteMember(t, sessionId, 'codex');

      const send = await t.fetch(`/v1/channels/${sessionId}/messages`, json('POST', { text: 'roster scoped task' }));
      expect(send.status).toBe(200);
      expect(await send.json()).toEqual({ accepted: true });
      const codexInput = await waitForFile(codex.stdinLog, 'roster scoped task');
      expect(codexInput).toContain('project_post');
      await Bun.sleep(100);
      expect(await readLogIfExists(claude.argsLog)).toBe('');
      expect(await readLogIfExists(claude.stdinLog)).toBe('');
    });

    test('project sessions inherit the Workplace Project cwd for managed MeshAgent fanout', async () => {
      const projectDir = join(dir, 'project-inherited-cwd');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockMeshAgent(t, dir, { agentName: 'codex' });
      const projectId = await createWorkplaceProject(t, projectDir);
      const project = await _getWorkplaceProject(t, projectId);
      const sessionId = await createProjectSession(t, projectId);
      await setMemberTemplates(t, projectId, [meshAgentTemplate('codex', 'codex', { launchMode: 'pty' })]);
      await inviteMember(t, sessionId, 'codex');

      expect(handlers.store.getSession(sessionId)?.cwd).toBe(project.cwd);

      const send = await t.fetch(`/v1/channels/${sessionId}/messages`, json('POST', { text: 'inherited cwd task' }));
      expect(send.status).toBe(200);
      expect(await send.json()).toEqual({ accepted: true });

      const input = await waitForFile(stdinLog, 'inherited cwd task');
      expect(input).toContain('Process this project message now.');
      expect(input).toContain('inherited cwd task');
      const sessions = handlers.store
        .listMeshSessionsForTranscriptTarget(sessionId)
        .filter((candidate) => candidate.runtimeRole === 'managed-project-agent');
      expect(sessions.map((nativeSession) => nativeSession.agentName)).toEqual(['codex']);
      expect(sessions[0]?.workingPath).toBe(await realpath(projectDir));
    });

    test('one MeshAgent template can be invited as isolated managed project agents', async () => {
      const projectDir = join(dir, 'project-template-instances');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockMeshAgent(t, dir, { agentName: 'codex' });
      const projectId = await createWorkplaceProject(t, projectDir);
      const sessionId = await createProjectSession(t, projectId, projectDir);
      await setMemberTemplates(t, projectId, [
        meshAgentTemplate(
          'pmem_codex_reviewer',
          'codex',
          { managedProjectAgent: true, launchMode: 'app-server' },
          'codex-reviewer'
        ),
        meshAgentTemplate(
          'pmem_codex_tester',
          'codex',
          { managedProjectAgent: true, launchMode: 'app-server' },
          'codex-tester'
        )
      ]);
      await inviteMember(t, sessionId, 'pmem_codex_reviewer');
      await inviteMember(t, sessionId, 'pmem_codex_tester');

      const input = await waitForFile(stdinLog, '"method":"thread/start"');
      expect(input.split('"method":"thread/start"').length - 1).toBeGreaterThanOrEqual(2);
      const sessions = handlers.store
        .listMeshSessionsForTranscriptTarget(sessionId)
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
        await t.fetch(`/v1/mesh/sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`, json('POST'));
      }
    });

    test('managed MeshAgent project member starts when cwd is set after member add', async () => {
      const projectDir = join(dir, 'project-member-late-cwd');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockMeshAgent(t, dir, { agentName: 'codex' });
      const projectId = await createWorkplaceProject(t);
      const sessionId = await createProjectSession(t, projectId);
      await setMemberTemplates(t, projectId, [
        meshAgentTemplate(
          'pmem_codex_reviewer',
          'codex',
          { managedProjectAgent: true, launchMode: 'app-server' },
          'codex-reviewer'
        )
      ]);
      await inviteMember(t, sessionId, 'pmem_codex_reviewer');
      expect(handlers.store.listMeshSessionsForTranscriptTarget(sessionId)).toEqual([]);

      await updateWorkplaceProjectCwd(t, projectId, projectDir);
      await t.fetch(`/v1/sessions/${sessionId}`, json('PATCH', { cwd: projectDir }));
      await t.fetch(`/v1/channels/${sessionId}/messages`, json('POST', { text: 'start after cwd' }));

      await waitForFile(stdinLog, '"method":"thread/start"');
      const sessions = handlers.store
        .listMeshSessionsForTranscriptTarget(sessionId)
        .filter((candidate) => candidate.runtimeRole === 'managed-project-agent');
      expect(sessions.map((nativeSession) => nativeSession.agentName)).toEqual(['pmem_codex_reviewer']);
      expect(sessions[0]?.workingPath).toBe(await realpath(projectDir));
      for (const nativeSession of sessions) {
        await t.fetch(`/v1/mesh/sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`, json('POST'));
      }
    });

    test('renaming a managed MeshAgent project member does not change its runtime identity', async () => {
      const projectDir = join(dir, 'project-member-rename');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockMeshAgent(t, dir, { agentName: 'codex' });
      const projectId = await createWorkplaceProject(t, projectDir);
      const sessionId = await createProjectSession(t, projectId, projectDir);
      await setMemberTemplates(t, projectId, [
        meshAgentTemplate('pmem_codex_reviewer', 'codex', { managedProjectAgent: true, launchMode: 'pty' }, 'Reviewer')
      ]);
      await inviteMember(t, sessionId, 'pmem_codex_reviewer');
      await waitForValue(
        () =>
          handlers.store
            .listMeshSessionsForTranscriptTarget(sessionId)
            .find((candidate) => candidate.runtimeRole === 'managed-project-agent'),
        'managed project member runtime'
      );

      await setMemberTemplates(t, projectId, [
        meshAgentTemplate(
          'pmem_codex_reviewer',
          'codex',
          { managedProjectAgent: true, launchMode: 'pty' },
          'Renamed reviewer'
        )
      ]);

      const send = await t.fetch(`/v1/channels/${sessionId}/messages`, json('POST', { text: 'after rename task' }));
      expect(send.status).toBe(200);
      const input = await waitForFile(stdinLog, 'after rename task');
      const notice = input.slice(input.lastIndexOf('New Workplace Project message is available.'));
      expect(notice).toContain('New Workplace Project message is available.');
      expect(notice).not.toContain('Your display name: Renamed reviewer');
      expect(notice).not.toContain('Your runtime agent id: pmem_codex_reviewer');
      expect(notice).not.toContain('Provider: codex');

      const sessions = handlers.store
        .listMeshSessionsForTranscriptTarget(sessionId)
        .filter((candidate) => candidate.runtimeRole === 'managed-project-agent');
      expect(sessions.map((nativeSession) => nativeSession.agentName)).toEqual(['pmem_codex_reviewer']);
      for (const nativeSession of sessions) {
        await t.fetch(`/v1/mesh/sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`, json('POST'));
      }
    });

    test('managed MeshAgent project member is started and receives an inbox notice for public project messages', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { envLog, stdinLog } = await configureMockMeshAgent(t, dir);
      const projectId = await createWorkplaceProject(t, projectDir);
      const sessionId = await createProjectSession(t, projectId, projectDir);
      await setMemberTemplates(t, projectId, [meshAgentTemplate('codex', 'codex', { launchMode: 'pty' })]);
      await inviteMember(t, sessionId, 'codex');

      const send = await t.fetch(`/v1/channels/${sessionId}/messages`, json('POST', { text: 'please review this' }));
      expect(send.status).toBe(200);
      expect(await send.json()).toEqual({ accepted: true });
      const snapshotEvents = await t.sse(`/v1/sessions/${sessionId}/ui-stream`, {
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

      const input = await waitForFile(stdinLog, 'please review this');
      expect(input).toContain('Process this project message now.');
      expect(input).toContain('Sender kind: human');
      expect(input).toContain('Sender name:');
      expect(input).toContain('Sender mention token:');
      expect(input).toContain('human');
      expect(input).toContain('please review this');
      const notice = input.slice(input.lastIndexOf('New Workplace Project message is available.'));
      expect(notice).not.toContain('Your display name:');
      expect(notice).not.toContain('Your runtime agent id:');
      expect(notice).not.toContain('Template agent:');
      expect(notice).not.toContain('Provider:');
      const envText = await waitForFile(envLog, TEST_MESH_AGENT_SERVER_URL);
      expect(JSON.parse(envText.trim().split(/\n/).at(-1) ?? '{}')).toMatchObject({
        MONAD_SERVER_URL: TEST_MESH_AGENT_SERVER_URL
      });
      const messages = await waitForMessages(t, sessionId, 2);
      expect(messages.filter((message) => message.text).map((message) => [message.role, message.text])).toEqual([
        ['user', 'please review this']
      ]);
      const listed = await t.fetch(`/v1/mesh/sessions?transcriptTargetId=${sessionId}`);
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
      if (!nativeSession) throw new Error('managed MeshAgent session was not started');
      expect(handlers.store.listMeshAgentInbox(nativeSession.id)).toEqual([]);
      expect(nativeSession.workingPath).toBe(await realpath(projectDir));
      const agentWorkspace = join(makePaths(dir).home, 'workplace-agents', sessionId, nativeSession.agentName);
      expect(await readFile(join(agentWorkspace, '.monad-agent-token'), 'utf8')).not.toBe('');
      await t.fetch(`/v1/mesh/sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`, json('POST'));
      expect(await readFile(join(agentWorkspace, '.monad-agent-token'), 'utf8').catch(() => null)).toBeNull();
      const projectMemory = join(makePaths(dir).home, 'workplace-agents', sessionId, 'MEMORY.md');
      expect(await readFile(projectMemory, 'utf8')).toContain('Project memory index');
    });

    test('running managed MeshAgent member receives a busy inbox notice without the full project message body', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockMeshAgent(t, dir);
      const projectId = await createWorkplaceProject(t, projectDir);
      const sessionId = await createProjectSession(t, projectId, projectDir);
      await setMemberTemplates(t, projectId, [
        meshAgentTemplate('codex', 'codex', { managedProjectAgent: true, launchMode: 'pty' })
      ]);
      await inviteMember(t, sessionId, 'codex');

      const first = await t.fetch(`/v1/channels/${sessionId}/messages`, json('POST', { text: 'first project task' }));
      expect(first.status).toBe(200);
      await waitForFile(stdinLog, 'first project task');

      const second = await t.fetch(
        `/v1/channels/${sessionId}/messages`,
        json('POST', { text: 'second secret busy task' })
      );
      expect(second.status).toBe(200);
      const input = await waitForFile(stdinLog, 'You are being woken to process the pending project inbox now.');
      expect(input).toContain('first project task');
      expect(input).not.toContain('second secret busy task');
      expect(input).toContain('New Workplace Project message is available.');
      expect(input).toContain('You are being woken to process the pending project inbox now.');
      expect(input).toContain('The message body is in your project inbox.');
      expect(input).not.toContain('If a public response is appropriate');
      expect(input).not.toContain('Every `project_post`, `project_ask`, or `agent_send` call must include');

      const third = await t.fetch(
        `/v1/channels/${sessionId}/messages`,
        json('POST', { text: 'third secret busy task' })
      );
      expect(third.status).toBe(200);
      await Bun.sleep(100);
      const afterThird = await readFile(stdinLog, 'utf8');
      expect(afterThird.split('You are being woken to process the pending project inbox now.').length - 1).toBe(1);
      expect(afterThird).not.toContain('third secret busy task');

      const [nativeSession] = handlers.store.listMeshSessionsForTranscriptTarget(sessionId);
      if (nativeSession) {
        expect(
          handlers.store.listMeshAgentInbox(nativeSession.id).map((item) => [item.deliveryState, item.message.text])
        ).toEqual([
          ['delivered', 'second secret busy task'],
          ['delivered', 'third secret busy task']
        ]);
      }
      if (nativeSession)
        await t.fetch(`/v1/mesh/sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`, json('POST'));
    });

    test('managed MeshAgent project member resumes a stored provider session ref', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { argsLog } = await configureMockMeshAgent(t, dir, { agentName: 'claude' });
      const projectId = await createWorkplaceProject(t, projectDir);
      const sessionId = await createProjectSession(t, projectId, projectDir);
      handlers.store.upsertMeshSession({
        id: 'mesh_oldclaude000',
        transcriptTargetId: sessionId,
        agentName: 'claude',
        provider: 'claude-code',
        workingPath: projectDir,
        launchMode: 'pty',
        runtimeRole: 'managed-project-agent',
        agentRuntimeId: 'mesh_oldclaude000',
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
      await setMemberTemplates(t, projectId, [
        meshAgentTemplate('claude', 'claude', { managedProjectAgent: true, launchMode: 'pty' })
      ]);
      await inviteMember(t, sessionId, 'claude');

      const send = await t.fetch(`/v1/channels/${sessionId}/messages`, json('POST', { text: 'resume this task' }));
      expect(send.status).toBe(200);

      const args = await waitForFile(argsLog, '--resume claude-session-resume');
      expect(args).toContain('--append-system-prompt-file');
      const resumed = handlers.store
        .listMeshSessionsForTranscriptTarget(sessionId)
        .find((candidate) => candidate.agentName === 'claude' && candidate.state === 'running');
      expect(resumed?.providerSessionRef).toBe('claude-session-resume');
      if (resumed) await t.fetch(`/v1/mesh/sessions/${resumed.id}/stop?transcriptTargetId=${sessionId}`, json('POST'));
    });

    test('managed MeshAgent project member falls back to a cold start when provider resume fails', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockCodexResumeFailureAgent(t, dir);
      const projectId = await createWorkplaceProject(t, projectDir);
      const sessionId = await createProjectSession(t, projectId, projectDir);
      handlers.store.upsertMeshSession({
        id: 'mesh_oldcodex0000',
        transcriptTargetId: sessionId,
        agentName: 'codex-resume-failure',
        provider: 'codex',
        workingPath: projectDir,
        launchMode: 'app-server',
        runtimeRole: 'managed-project-agent',
        agentRuntimeId: 'mesh_oldcodex0000',
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
      await setMemberTemplates(t, projectId, [
        meshAgentTemplate('codex-resume-failure', 'codex-resume-failure', {
          managedProjectAgent: true,
          launchMode: 'app-server'
        })
      ]);
      await inviteMember(t, sessionId, 'codex-resume-failure');

      const resumeFailedP = t.sse(`/v1/sessions/${sessionId}/events`, {
        until: (event) => event.type === 'mesh.resume_failed',
        timeoutMs: 3000
      });
      const send = await t.fetch(
        `/v1/channels/${sessionId}/messages`,
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
        .listMeshSessionsForTranscriptTarget(sessionId)
        .find((candidate) => candidate.agentName === 'codex-resume-failure' && candidate.state === 'running');
      expect(coldStarted?.providerSessionRef).toBe('codex-thread-fresh');
      expect(handlers.store.getMeshSession('mesh_oldcodex0000')?.providerSessionRef).toBeNull();
      if (coldStarted)
        await t.fetch(`/v1/mesh/sessions/${coldStarted.id}/stop?transcriptTargetId=${sessionId}`, json('POST'));
    });

    test('managed MeshAgent project member start failures are written to the project transcript', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      await configureMockCodexStartFailureAgent(t, dir);
      const projectId = await createWorkplaceProject(t, projectDir);
      const sessionId = await createProjectSession(t, projectId, projectDir);
      await setMemberTemplates(t, projectId, [
        meshAgentTemplate('codex-start-failure', 'codex-start-failure', {
          managedProjectAgent: true,
          launchMode: 'app-server'
        })
      ]);

      await inviteMember(t, sessionId, 'codex-start-failure');

      const messages = await waitForMessages(t, sessionId, 1);
      expect(messages[0]?.role).toBe('assistant');
      expect(messages[0]?.text).toContain('codex-start-failure failed to join the project:');
    });

    test('managed MeshAgent project member requires Studio reconnect when provider auth is unauthenticated', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockMeshAgent(t, dir, { authState: 'unauthenticated' });
      const projectId = await createWorkplaceProject(t, projectDir);
      const sessionId = await createProjectSession(t, projectId, projectDir);
      await setMemberTemplates(t, projectId, [
        meshAgentTemplate('codex', 'codex', { managedProjectAgent: true, launchMode: 'pty' })
      ]);

      const eventsP = t.sse(`/v1/sessions/${sessionId}/events`, {
        until: (event) => event.type === 'mesh.connection_required',
        timeoutMs: 3000
      });
      await inviteMember(t, sessionId, 'codex');
      const send = await t.fetch(`/v1/channels/${sessionId}/messages`, json('POST', { text: 'please review this' }));
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
      const listed = await t.fetch(`/v1/mesh/sessions?transcriptTargetId=${sessionId}`);
      expect(listed.status).toBe(200);
      expect(((await listed.json()) as { sessions: unknown[] }).sessions).toEqual([]);
    });

    test('managed MeshAgent project post fans out to other managed MeshAgent members', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog: codexStdinLog } = await configureMockMeshAgent(t, dir, { agentName: 'codex' });
      const { stdinLog: claudeStdinLog } = await configureMockMeshAgent(t, dir, { agentName: 'claude' });
      const projectId = await createWorkplaceProject(t, projectDir);
      const sessionId = await createProjectSession(t, projectId, projectDir);
      await setMemberTemplates(t, projectId, [
        meshAgentTemplate('codex', 'codex', { managedProjectAgent: true, launchMode: 'pty' }),
        meshAgentTemplate('claude', 'claude', { managedProjectAgent: true, launchMode: 'pty' })
      ]);
      await inviteMember(t, sessionId, 'codex');
      await inviteMember(t, sessionId, 'claude');

      const send = await t.fetch(`/v1/channels/${sessionId}/messages`, json('POST', { text: 'initial project task' }));
      expect(send.status).toBe(200);
      await waitForFile(codexStdinLog, 'initial project task');
      await waitForFile(claudeStdinLog, 'initial project task');

      const nativeSessions = handlers.store.listMeshSessionsForTranscriptTarget(sessionId);
      const codexSession = nativeSessions.find((candidate) => candidate.agentName === 'codex');
      expect(typeof codexSession?.id).toBe('string');
      if (!codexSession) throw new Error('codex managed MeshAgent session was not started');
      handlers.store.upsertMeshSession({ ...codexSession, agentRuntimeTokenHash: tokenHash() });

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

      // The post body itself stays in the inbox; the fan-out only writes a sender-tagged notice.
      const claudeInput = await waitForFile(claudeStdinLog, 'Sender name: codex');
      expect(claudeInput).toContain('The message body is in your project inbox.');
      expect(claudeInput).toContain('Sender kind: mesh-agent');
      expect(claudeInput).toContain('Sender name: codex');
      expect(claudeInput).toContain('Sender mention token:');
      expect(claudeInput).toContain('mesh-agent:codex');
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
      expect(directNotice).toContain('Follow your managed runtime instructions for private/direct messages.');
      expect(directNotice).not.toContain('Use the `agent_read` tool');
      expect(handlers.store.listMessages(sessionId, { latest: true }).filter((message) => message.text)).toHaveLength(
        2
      );
      for (const nativeSession of nativeSessions) {
        await t.fetch(`/v1/mesh/sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`, json('POST'));
      }
    });

    test('MeshAgent mention forwards input to the provider-owned CLI session through the channel route', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockMeshAgent(t, dir);
      const projectId = await createWorkplaceProject(t, projectDir);
      const sessionId = await createProjectSession(t, projectId, projectDir);
      await setMemberTemplates(t, projectId, [
        meshAgentTemplate('codex', 'codex', { managedProjectAgent: false, launchMode: 'pty' })
      ]);
      await inviteMember(t, sessionId, 'codex');

      const eventsP = t.sse(`/v1/sessions/${sessionId}/events`, {
        until: (event) =>
          event.type === 'mesh.started' && (event.payload as { agentName?: unknown }).agentName === 'codex',
        timeoutMs: 3000
      });
      const send = await t.fetch(
        `/v1/channels/${sessionId}/messages`,
        json('POST', { text: '@[name="codex" id="mesh-agent:codex"] inspect repo' })
      );
      if (send.status !== 200) throw new Error(await send.text());
      expect(send.status).toBe(200);
      expect(await send.json()).toEqual({ accepted: true });

      expect(await waitForFile(stdinLog, 'inspect repo\n')).toContain('inspect repo\n');
      const messages = await waitForMessages(t, sessionId, 1);
      expect(messages[0]?.text).toBe('@[name="codex" id="mesh-agent:codex"] inspect repo');
      const events = await eventsP;
      expect(events.some((event) => event.type === 'mesh.started' && event.payload.agentName === 'codex')).toBe(true);
      const listed = await t.fetch(`/v1/mesh/sessions?transcriptTargetId=${sessionId}`);
      expect(listed.status).toBe(200);
      const nativeSessionId = ((await listed.json()) as { sessions: Array<{ id: string }> }).sessions[0]?.id;
      expect(typeof nativeSessionId).toBe('string');
      await t.fetch(`/v1/mesh/sessions/${nativeSessionId}/stop?transcriptTargetId=${sessionId}`, json('POST'));
    });

    test('MeshAgent mention requires Studio reconnect when provider auth status is unauthenticated', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockMeshAgent(t, dir, { authState: 'unauthenticated' });
      const projectId = await createWorkplaceProject(t, projectDir);
      const sessionId = await createProjectSession(t, projectId, projectDir);
      await setMemberTemplates(t, projectId, [
        meshAgentTemplate('codex', 'codex', { managedProjectAgent: false, launchMode: 'pty' })
      ]);
      await inviteMember(t, sessionId, 'codex');

      const eventsP = t.sse(`/v1/sessions/${sessionId}/events`, {
        until: (event) => event.type === 'mesh.connection_required',
        timeoutMs: 3000
      });
      const send = await t.fetch(
        `/v1/channels/${sessionId}/messages`,
        json('POST', { text: '@[name="codex" id="mesh-agent:codex"] inspect repo' })
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
      expect(messages[0]?.text).toBe('@[name="codex" id="mesh-agent:codex"] inspect repo');
      expect(messages[1]?.text).toContain('Reconnect codex in Studio');
    });

    test('MeshAgent mention requires Studio check when provider readiness is unknown', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockMeshAgent(t, dir, { authState: 'unknown' });
      const projectId = await createWorkplaceProject(t, projectDir);
      const sessionId = await createProjectSession(t, projectId, projectDir);
      await setMemberTemplates(t, projectId, [
        meshAgentTemplate('codex', 'codex', { managedProjectAgent: false, launchMode: 'pty' })
      ]);
      await inviteMember(t, sessionId, 'codex');

      const send = await t.fetch(
        `/v1/channels/${sessionId}/messages`,
        json('POST', { text: '@[name="codex" id="mesh-agent:codex"] inspect repo' })
      );
      if (send.status !== 200) throw new Error(await send.text());
      expect(await send.json()).toEqual({ accepted: true });

      const stdinText = await readFile(stdinLog, 'utf8').catch(() => '');
      expect(stdinText).toBe('');
      const messages = await waitForMessages(t, sessionId, 2);
      expect(messages[0]?.text).toBe('@[name="codex" id="mesh-agent:codex"] inspect repo');
      expect(messages[1]?.text).toContain('Check codex connection in Studio');
    });

    test('MeshAgent mention without project working path records user message and visible error', async () => {
      await configureMockMeshAgent(t, dir);
      const projectId = await createWorkplaceProject(t);
      const sessionId = await createProjectSession(t, projectId);
      await setMemberTemplates(t, projectId, [
        meshAgentTemplate('codex', 'codex', { managedProjectAgent: false, launchMode: 'pty' })
      ]);
      await inviteMember(t, sessionId, 'codex');
      const send = await t.fetch(
        `/v1/channels/${sessionId}/messages`,
        json('POST', { text: '@[name="codex" id="mesh-agent:codex"] inspect repo' })
      );
      expect(send.status).toBe(200);
      expect(await send.json()).toEqual({ accepted: true });

      const messages = await waitForMessages(t, sessionId, 2);
      expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
      expect(messages[0]?.text).toBe('@[name="codex" id="mesh-agent:codex"] inspect repo');
      expect(messages[1]?.text).toContain('requires a project working path');
    });
  });
}
