import type { MonadPaths } from '@monad/environment';
import type {
  MeshAgentStateFrame,
  MeshSessionId,
  ProjectId,
  ProjectMember,
  Session,
  SessionId,
  SessionMemberBinding,
  UIMessageItem,
  UIPart,
  WorkplaceProject,
  WorkplaceProjectMemberSettings,
  WorkplaceProjectMemberTemplate
} from '@monad/protocol';
import type { ModelChunk, ModelRequest, ModelRouter } from '#/agent/model/index.ts';

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { initMonadHome, loadAuth, loadConfig } from '@monad/environment';
import { parseEventPayload, sessionMemberResponseSchema } from '@monad/protocol';

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
import { connectionGate, waitFor } from '../wait.ts';

setDefaultTimeout(process.platform === 'win32' ? 15_000 : 5_000);

let windowsMockMeshAgentCommand: Promise<string> | undefined;

function compileWindowsMockMeshAgent(bunCommand: string, script: string): Promise<string> {
  if (windowsMockMeshAgentCommand) return windowsMockMeshAgentCommand;
  windowsMockMeshAgentCommand = (async () => {
    const executable = join(tmpdir(), `monad-test-mock-mesh-agent-${process.pid}.exe`);
    const build = Bun.spawn([bunCommand, 'build', '--compile', script, '--outfile', executable], {
      stdout: 'pipe',
      stderr: 'pipe'
    });
    const exitCode = await build.exited;
    if (exitCode !== 0) {
      throw new Error(`failed to compile mock MeshAgent: ${await new Response(build.stderr).text()}`);
    }
    const warmup = Bun.spawn([executable, 'login', 'status'], {
      env: { ...process.env, MONAD_TEST_AUTH_STATE: 'authenticated' },
      stdout: 'ignore',
      stderr: 'ignore'
    });
    await warmup.exited;
    return executable;
  })();
  return windowsMockMeshAgentCommand;
}

const MANAGED_AGENT_TOKEN = 'managed-agent-token';
const TEST_MESH_AGENT_SERVER_URL = 'http://127.0.0.1:61234';

function makePaths(base: string): MonadPaths {
  return makeTestPaths(base);
}

async function comparablePath(path: string): Promise<string> {
  const canonicalPath = await realpath(path);
  return process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
}

async function removeTestDirectory(path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform !== 'win32' ||
        !['EACCES', 'EBUSY', 'EFAULT', 'EPERM'].includes(code ?? '') ||
        attempt === 49
      ) {
        throw error;
      }
      await Bun.sleep(20);
    }
  }
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
// Returns the canonical ProjectMember identity (its `id` is the projectMemberId, which is also the
// runtime agent name today) so existing call sites keep addressing the member by `.id`.
async function inviteMember(t: TransportHandle, sessionId: string, templateId: string): Promise<ProjectMember> {
  const res = await t.fetch(`/v1/sessions/${sessionId}/members`, json('POST', { templateId }));
  // Strict-parse the raw 201: the invite response is the canonical `.strict()` { member, binding }, so a
  // legacy extra on the wire would fail here. Exercised over both TCP and Unix by this suite.
  if (res.status === 201) return sessionMemberResponseSchema.parse(await res.json()).member;

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: `member already invited into this session: ${templateId}`,
    code: 'VALIDATION'
  });
  const listed = await t.fetch(`/v1/sessions/${sessionId}/members`);
  expect(listed.status).toBe(200);
  const members = ((await listed.json()) as { members: SessionMemberBinding[] }).members;
  const existing = members.find((entry) => entry.member.profileId === templateId);
  if (!existing) throw new Error(`reconciled member is missing from the session: ${templateId}`);
  return existing.member;
}

/** Build a managed mesh-agent member template. `id` is the Profile reference (the member's
 *  `templateId`), not the runtime id — inviting the template mints a fresh member whose
 *  `member.id` becomes the runtime agent id (agentName). `name` selects the registered
 *  mesh-agent config that backs it. */
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

async function listMessages(
  t: TransportHandle,
  sessionId: string
): Promise<Array<{ id: string; replyToMessageId?: string; role: string; text: string }>> {
  const route = sessionId.startsWith('prj_') ? 'projects' : 'sessions';
  const listed = await t.fetch(`/v1/${route}/${sessionId}/messages`);
  expect(listed.status).toBe(200);
  return (
    (await listed.json()) as {
      messages: Array<{ id: string; replyToMessageId?: string; role: string; text: string }>;
    }
  ).messages;
}

async function waitForMessages(t: TransportHandle, sessionId: string, count: number) {
  let messages: Awaited<ReturnType<typeof listMessages>> = [];
  await waitFor(
    async () => {
      messages = await listMessages(t, sessionId);
      return messages.length >= count;
    },
    { intervalMs: 5, message: `session never reached messages=${count}` }
  );
  return messages;
}

/** Wait on text-bearing messages. Empty placeholder rows are created and filled asynchronously, so a
 *  total-row count is not a usable signal for "the transcript has N visible messages yet". */
async function waitForTextMessages(t: TransportHandle, sessionId: string, count: number) {
  let messages: Awaited<ReturnType<typeof listMessages>> = [];
  await waitFor(
    async () => {
      messages = (await listMessages(t, sessionId)).filter(({ text }) => text);
      return messages.length >= count;
    },
    { intervalMs: 5, message: `session never reached textMessages=${count}` }
  );
  return messages;
}

function captureModel(requests: ModelRequest[], replies: string[]): ModelRouter {
  return {
    async *stream(req): AsyncIterable<ModelChunk> {
      requests.push(req);
      yield { type: 'text', token: replies.shift() ?? 'unexpected assistant' };
    },
    async complete(req) {
      requests.push(req);
      return {
        text: replies.shift() ?? 'unexpected assistant',
        finishReason: 'stop'
      };
    }
  };
}

const tokenHash = (token = MANAGED_AGENT_TOKEN): string => createHash('sha256').update(token).digest('hex');

function managedBindingHeaders(
  sessionId: string,
  meshSessionId: string,
  agentId: string,
  token = MANAGED_AGENT_TOKEN
): Record<string, string> {
  void sessionId;
  void agentId;
  return {
    authorization: `Bearer ${token}`,
    'x-monad-mesh-session-id': meshSessionId
  };
}

async function configureMockMeshAgent(
  t: TransportHandle,
  root: string,
  opts: {
    agentName?: string;
    provider?: 'claude-code' | 'codex';
    authState?: 'authenticated' | 'unauthenticated' | 'unknown';
    turnDelayMs?: number;
  } = {}
): Promise<{ argsLog: string; envLog: string; stdinLog: string }> {
  const agentName = opts.agentName ?? 'codex';
  const provider = opts.provider ?? (agentName === 'claude' || agentName === 'claude-code' ? 'claude-code' : 'codex');
  const script = join(root, `mock-mesh-agent-${agentName}.js`);
  const argsLog = join(root, `mock-mesh-agent-${agentName}-args.log`);
  const envLog = join(root, `mock-mesh-agent-${agentName}-env.jsonl`);
  const stdinLog = join(root, `mock-mesh-agent-${agentName}-stdin.log`);
  const bunCommand =
    process.platform === 'win32'
      ? [
          Bun.which('bun'),
          process.execPath,
          ...(process.env.PATH ?? '').split(delimiter).map((directory) => join(directory, 'bun.exe'))
        ].find((candidate): candidate is string =>
          Boolean(candidate && !candidate.toLowerCase().includes('bun-node-') && existsSync(candidate))
        )
      : script;
  if (!bunCommand) throw new Error('Bun executable is required');
  await writeFile(
    script,
    [
      '#!/usr/bin/env bun',
      'import { appendFileSync } from "node:fs";',
      'const argsLog = process.env.MONAD_TEST_ARGS_LOG;',
      'const envLog = process.env.MONAD_TEST_ENV_LOG;',
      'const stdinLog = process.env.MONAD_TEST_STDIN_LOG;',
      'const authState = process.env.MONAD_TEST_AUTH_STATE;',
      'const provider = process.env.MONAD_TEST_PROVIDER;',
      'const turnDelayMs = Number(process.env.MONAD_TEST_TURN_DELAY_MS ?? 0);',
      'const args = process.argv.slice(2).join(" ");',
      'if (args === "login status" || args === "auth status" || args === "auth status --json") {',
      '  process.stdout.write(JSON.stringify({ state: authState }) + "\\n");',
      '  process.exit(0);',
      '}',
      'appendFileSync(argsLog, args + "\\n");',
      'appendFileSync(envLog, JSON.stringify({ MONAD_SERVER_URL: process.env.MONAD_SERVER_URL, CODEX_NON_INTERACTIVE: process.env.CODEX_NON_INTERACTIVE }) + "\\n");',
      'process.stdin.on("data", (d) => appendFileSync(stdinLog, d.toString()));',
      'if (provider === "codex" && process.argv.includes("app-server")) {',
      '  let buffer = "";',
      '  let turn = 0;',
      '  const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");',
      '  const complete = (threadId, turnId) => {',
      '    const finish = () => send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [] } } });',
      '    if (turnDelayMs > 0) setTimeout(finish, turnDelayMs);',
      '    else setTimeout(finish, 0);',
      '  };',
      '  process.stdin.on("data", (chunk) => {',
      '    buffer += chunk.toString();',
      '    const lines = buffer.split("\\n");',
      '    buffer = lines.pop() ?? "";',
      '    for (const line of lines) {',
      '      if (!line.trim()) continue;',
      '      const request = JSON.parse(line);',
      '      if (request.method === "initialize") send({ id: request.id, result: {} });',
      '      else if (request.method === "thread/start" || request.method === "thread/resume") {',
      '        const threadId = request.params?.threadId ?? "codex-thread-" + process.pid;',
      '        send({ id: request.id, result: { thread: { id: threadId } } });',
      '      } else if (request.method === "turn/start") {',
      '        const turnId = "turn-" + ++turn;',
      '        send({ id: request.id, result: { turn: { id: turnId } } });',
      '        complete(request.params.threadId, turnId);',
      '      } else if (request.method === "turn/steer") {',
      '        send({ id: request.id, result: { turnId: request.params.expectedTurnId } });',
      '      } else if (request.method === "turn/interrupt") {',
      '        send({ id: request.id, result: {} });',
      '      }',
      '    }',
      '  });',
      '  await new Promise(() => {});',
      '} else {',
      'const completeTurn = () => {',
      '  const resume = process.argv.indexOf("--resume");',
      '  const sessionId = resume >= 0 ? process.argv[resume + 1] : "claude-session-" + process.pid;',
      '  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }) + "\\n");',
      '  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "", permission_denials: [] }) + "\\n");',
      '};',
      'process.stdin.on("end", () => {',
      '  if (turnDelayMs > 0) setTimeout(completeTurn, turnDelayMs);',
      '  else completeTurn();',
      '});',
      '}'
    ].join('\n')
  );
  await chmod(script, 0o755);
  const command = process.platform === 'win32' ? await compileWindowsMockMeshAgent(bunCommand, script) : script;
  const res = await t.fetch(
    `/v1/mesh/agents/${agentName}`,
    json('PUT', {
      agent: {
        name: agentName,
        provider,
        command,
        args: [],
        env: {
          MONAD_TEST_ARGS_LOG: argsLog,
          MONAD_TEST_ENV_LOG: envLog,
          MONAD_TEST_STDIN_LOG: stdinLog,
          MONAD_TEST_AUTH_STATE: opts.authState ?? 'authenticated',
          MONAD_TEST_PROVIDER: provider,
          MONAD_TEST_TURN_DELAY_MS: String(opts.turnDelayMs ?? 0)
        },
        enabled: true,
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

type ManagedIngressBatch = {
  batchId: string;
  messages: Array<{
    ingressSeq: number;
    source: string;
    text: string;
    fromAgent?: string;
    peer?: string;
    replyToMessageId?: string;
    sender?: { id?: string; kind: string; name: string };
  }>;
};

function managedIngressBatches(input: string): ManagedIngressBatch[] {
  const promptTexts = [input];
  for (const line of input.trim().split(/\n/)) {
    try {
      const event = JSON.parse(line) as {
        message?: { content?: Array<{ text?: string }> };
        params?: { input?: Array<{ text?: string }> };
      };
      for (const part of event.message?.content ?? []) {
        if (part.text) promptTexts.push(part.text);
      }
      for (const part of event.params?.input ?? []) {
        if (part.text) promptTexts.push(part.text);
      }
    } catch {}
  }
  return promptTexts.flatMap((prompt) =>
    prompt
      .split(/\n/)
      .filter((line) => line.startsWith('{"batchId":'))
      .map((line) => JSON.parse(line) as ManagedIngressBatch)
  );
}

async function waitForFile(path: string, expected: string, attempts = 120): Promise<string> {
  for (let i = 0; i < attempts; i++) {
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

// MeshAgent login requirements now travel only on the neutral mesh-state stream (the daemon no longer
// projects login cards onto the ui-stream), surfacing either folded into a snapshot or as a live event.
function meshLoginRequirements(frame: MeshAgentStateFrame): { agentName: string; provider: string }[] {
  if (frame.kind === 'snapshot') {
    return frame.loginRequirements.map((login) => ({ agentName: login.agentName, provider: login.provider }));
  }
  if (frame.kind === 'event' && frame.event.type === 'mesh.login_required') {
    const payload = frame.event.payload as { agentName: string; provider: string };
    return [{ agentName: payload.agentName, provider: payload.provider }];
  }
  return [];
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
      handlers._stopMeshAgents();
      await t.stop();
      await removeTestDirectory(dir);
    });

    test('no-host project message records reply relations through the channel route', async () => {
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

      const firstMessages = await waitForMessages(t, sessionId, 1);
      const targetId = firstMessages[0]?.id;
      if (!targetId) throw new Error('expected the first channel message');
      const reply = await t.fetch(
        `/v1/channels/${sessionId}/messages`,
        json('POST', { text: 'timeline reply', replyToMessageId: targetId })
      );
      expect(reply.status).toBe(200);

      const messages = await waitForMessages(t, sessionId, 2);
      expect(messages.map(({ replyToMessageId, role, text }) => ({ replyToMessageId, role, text }))).toEqual([
        { replyToMessageId: undefined, role: 'user', text: 'timeline only' },
        { replyToMessageId: targetId, role: 'user', text: 'timeline reply' }
      ]);
      expect(modelRequests).toEqual([]);
    });

    test('clarification answers persist as canonical user replies to their question', async () => {
      const projectId = await createWorkplaceProject(t);
      const sessionId = await createProjectSession(t, projectId);
      const gate = connectionGate();
      const requested = t.sse(`/v1/sessions/${sessionId}/events`, {
        until: (event) => event.type === 'clarify.requested',
        timeoutMs: 3000,
        onConnected: gate.onConnected
      });
      await gate.ready;
      const answer = handlers.clarify.askStructured(sessionId, { question: 'Ship this reply design?' });
      const requestEvent = (await requested).find((event) => event.type === 'clarify.requested');
      if (!requestEvent) throw new Error('clarification request event missing');
      const request = parseEventPayload('clarify.requested', requestEvent.payload);

      const response = await t.fetch(
        '/v1/clarifications/respond',
        json('POST', { requestId: request.requestId, answer: 'Ship it' })
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: 'answered',
        answer: 'Ship it',
        resolvedAt: expect.any(String)
      });
      const result = await answer;
      if (!result.answerMessageId) throw new Error('clarification answer message ID missing');
      const messages = handlers.store.listMessages(sessionId);
      expect(
        messages.map(({ id, replyToMessageId, role, text, type }) => ({ id, replyToMessageId, role, text, type }))
      ).toEqual([
        {
          id: request.questionMessageId,
          replyToMessageId: undefined,
          role: 'assistant',
          text: 'Ship this reply design?',
          type: 'clarify'
        },
        {
          id: result.answerMessageId,
          replyToMessageId: request.questionMessageId,
          role: 'user',
          text: 'Ship it',
          type: 'text'
        }
      ]);
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
      await waitFor(() => handlers.store.getSession(sessionId)?.cwd === projectDir, {
        message: '/workdir never applied to the session'
      });
      expect(handlers.store.getSession(sessionId)?.cwd).toBe(projectDir);
      expect(handlers.store.getWorkplaceProject(projectId)?.cwd ?? null).toBeNull();
      expect(modelRequests).toEqual([]);
    });

    test('inviting a managed MeshAgent project member starts only that member runtime', async () => {
      const projectDir = join(dir, 'project-add-member');
      await mkdir(projectDir, { recursive: true });
      const codex = await configureMockMeshAgent(t, dir, {
        agentName: 'codex'
      });
      const claude = await configureMockMeshAgent(t, dir, {
        agentName: 'claude-code'
      });
      const projectId = await createWorkplaceProject(t, projectDir);
      const sessionId = await createProjectSession(t, projectId, projectDir);
      await setMemberTemplates(t, projectId, [meshAgentTemplate('codex', 'codex', {})]);
      const member = await inviteMember(t, sessionId, 'codex');
      await waitForFile(codex.envLog, TEST_MESH_AGENT_SERVER_URL);
      expect(await readLogIfExists(claude.envLog)).toBe('');

      const listed = await t.fetch(`/v1/mesh/sessions?transcriptTargetId=${sessionId}`);
      expect(listed.status).toBe(200);
      const sessions = ((await listed.json()) as { sessions: Array<{ agentName: string }> }).sessions;
      // The managed runtime's agentName is the member's stable identity (the fresh pmem id).
      expect([...new Set(sessions.map((nativeSession) => nativeSession.agentName))]).toEqual([member.id]);
    });

    test('project messages wake only MeshAgent members in the project roster', async () => {
      const projectDir = join(dir, 'project-roster-only');
      await mkdir(projectDir, { recursive: true });
      const codex = await configureMockMeshAgent(t, dir, {
        agentName: 'codex'
      });
      const claude = await configureMockMeshAgent(t, dir, {
        agentName: 'claude-code'
      });
      const projectId = await createWorkplaceProject(t, projectDir);
      const sessionId = await createProjectSession(t, projectId, projectDir);
      await setMemberTemplates(t, projectId, [meshAgentTemplate('codex', 'codex', {})]);
      await inviteMember(t, sessionId, 'codex');

      const send = await t.fetch(`/v1/channels/${sessionId}/messages`, json('POST', { text: 'roster scoped task' }));
      expect(send.status).toBe(200);
      expect(await send.json()).toEqual({ accepted: true });
      const codexInput = await waitForFile(codex.stdinLog, 'roster scoped task');
      const threadStart = codexInput
        .trim()
        .split(/\n/)
        .map((line) => JSON.parse(line) as { method?: string; params?: { developerInstructions?: string } })
        .find((request) => request.method === 'thread/start');
      expect(threadStart?.params?.developerInstructions).toContain('project_post');
      expect(threadStart?.params?.developerInstructions).toContain(
        'When member availability is relevant or uncertain, call the `session_members` tool before delegating, mentioning, or sending a private message.'
      );
      const turnInput = codexInput
        .trim()
        .split(/\n/)
        .map((line) => JSON.parse(line) as { method?: string; params?: { input?: Array<{ text?: string }> } })
        .filter((request) => request.method === 'turn/start')
        .flatMap((request) => request.params?.input ?? [])
        .map((part) => part.text ?? '')
        .join('\n');
      // presence-ok: immutable bridge instructions must not be duplicated into provider user history.
      expect(turnInput).not.toContain('project_post');
      expect(turnInput).not.toContain(
        'When member availability is relevant or uncertain, call the `session_members` tool before delegating, mentioning, or sending a private message.'
      );
      await Bun.sleep(100);
      expect(await readLogIfExists(claude.argsLog)).toBe('');
      expect(await readLogIfExists(claude.stdinLog)).toBe('');
    });

    test('session members expose working before the managed provider emits its first event', async () => {
      const projectDir = join(dir, 'project-immediate-working');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockMeshAgent(t, dir, {
        agentName: 'codex',
        turnDelayMs: 1_000
      });
      const projectId = await createWorkplaceProject(t, projectDir);
      const sessionId = await createProjectSession(t, projectId, projectDir);
      await setMemberTemplates(t, projectId, [meshAgentTemplate('codex', 'codex', {})]);
      const invited = await inviteMember(t, sessionId, 'codex');

      const send = await t.fetch(`/v1/channels/${sessionId}/messages`, json('POST', { text: 'show working now' }));
      expect(send.status).toBe(200);
      expect(await send.json()).toEqual({ accepted: true });
      await waitForFile(stdinLog, 'show working now');

      const members = await t.fetch(`/v1/sessions/${sessionId}/members`);
      expect(members.status).toBe(200);
      const entry = ((await members.json()) as { members: SessionMemberBinding[] }).members[0];
      // The wire no longer carries loop/connection state (that projection moved off the daemon). What it
      // does expose canonically is the binding: the member is active and bound to a live managed runtime,
      // recorded as the binding's currentNativeRuntimeSessionId once the provider process is owned.
      expect(entry?.member.id).toBe(invited.id);
      expect(entry?.binding.lifecycle).toBe('active');
      expect(typeof entry?.binding.currentNativeRuntimeSessionId).toBe('string');
    });

    test('project sessions inherit the Workplace Project cwd for managed MeshAgent fanout', async () => {
      const projectDir = join(dir, 'project-inherited-cwd');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockMeshAgent(t, dir, {
        agentName: 'codex'
      });
      const projectId = await createWorkplaceProject(t, projectDir);
      const project = await _getWorkplaceProject(t, projectId);
      const sessionId = await createProjectSession(t, projectId);
      await setMemberTemplates(t, projectId, [meshAgentTemplate('codex', 'codex', {})]);
      const member = await inviteMember(t, sessionId, 'codex');

      expect(handlers.store.getSession(sessionId)?.cwd).toBe(project.cwd);

      const send = await t.fetch(`/v1/channels/${sessionId}/messages`, json('POST', { text: 'inherited cwd task' }));
      expect(send.status).toBe(200);
      expect(await send.json()).toEqual({ accepted: true });

      const input = await waitForFile(stdinLog, 'inherited cwd task');
      expect(
        managedIngressBatches(input).flatMap((batch) =>
          batch.messages.map(({ sender, source, text }) => ({ sender, source, text }))
        )
      ).toContainEqual({
        sender: { kind: 'human', name: 'zeke', id: 'human' },
        source: 'project',
        text: 'inherited cwd task'
      });
      const sessions = handlers.store
        .listMeshSessionsForTranscriptTarget(sessionId)
        .filter((candidate) => candidate.runtimeRole === 'managed-project-agent');
      expect(
        sessions.map(({ id, agentName, state, providerSessionRef, exitCode }) => ({
          id,
          agentName,
          state,
          providerSessionRef,
          exitCode
        }))
      ).toEqual([
        {
          id: expect.any(String),
          agentName: member.id,
          state: 'running',
          providerSessionRef: expect.any(String),
          exitCode: null
        }
      ]);
      expect(await comparablePath(sessions[0]?.workingPath ?? '')).toBe(await comparablePath(projectDir));
    });

    test('one MeshAgent template can be invited as isolated managed project agents', async () => {
      const projectDir = join(dir, 'project-template-instances');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockMeshAgent(t, dir, {
        agentName: 'codex'
      });
      const projectId = await createWorkplaceProject(t, projectDir);
      const sessionId = await createProjectSession(t, projectId, projectDir);
      await setMemberTemplates(t, projectId, [
        meshAgentTemplate('pmem_codex_reviewer', 'codex', { managedProjectAgent: true }, 'codex-reviewer'),
        meshAgentTemplate('pmem_codex_tester', 'codex', { managedProjectAgent: true }, 'codex-tester')
      ]);
      const reviewer = await inviteMember(t, sessionId, 'pmem_codex_reviewer');
      const tester = await inviteMember(t, sessionId, 'pmem_codex_tester');

      const input = await waitForFile(stdinLog, 'joined');
      expect(input.split('joined').length - 1).toBeGreaterThanOrEqual(2);
      const sessions = handlers.store
        .listMeshSessionsForTranscriptTarget(sessionId)
        .filter((candidate) => candidate.runtimeRole === 'managed-project-agent');
      // Two isolated members from one template → two distinct runtimes named by their member ids.
      expect(sessions.map((nativeSession) => nativeSession.agentName).sort()).toEqual([reviewer.id, tester.id].sort());
      expect(
        new Set(await Promise.all(sessions.map((nativeSession) => comparablePath(nativeSession.workingPath))))
      ).toEqual(new Set([await comparablePath(projectDir)]));
      expect(
        new Set(
          sessions.map((nativeSession) => join(makePaths(dir).home, 'workplace', sessionId, nativeSession.agentName))
        ).size
      ).toBe(2);
      for (const nativeSession of sessions) {
        await t.fetch(`/v1/mesh/sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`, json('POST'));
      }
    });

    test('managed MeshAgent project member starts when the session cwd is set after member add', async () => {
      const projectDir = join(dir, 'project-member-late-cwd');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockMeshAgent(t, dir, {
        agentName: 'codex'
      });
      const projectId = await createWorkplaceProject(t);
      const sessionId = await createProjectSession(t, projectId);
      await setMemberTemplates(t, projectId, [
        meshAgentTemplate('pmem_codex_reviewer', 'codex', { managedProjectAgent: true }, 'codex-reviewer')
      ]);
      const member = await inviteMember(t, sessionId, 'pmem_codex_reviewer');
      expect(handlers.store.listMeshSessionsForTranscriptTarget(sessionId)).toEqual([]);

      await t.fetch(`/v1/sessions/${sessionId}`, json('PATCH', { cwd: projectDir }));
      await t.fetch(`/v1/channels/${sessionId}/messages`, json('POST', { text: 'start after cwd' }));

      await waitForFile(stdinLog, 'start after cwd');
      const sessions = handlers.store
        .listMeshSessionsForTranscriptTarget(sessionId)
        .filter((candidate) => candidate.runtimeRole === 'managed-project-agent');
      expect([...new Set(sessions.map((nativeSession) => nativeSession.agentName))]).toEqual([member.id]);
      expect(await comparablePath(sessions[0]?.workingPath ?? '')).toBe(await comparablePath(projectDir));
      for (const nativeSession of sessions) {
        await t.fetch(`/v1/mesh/sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`, json('POST'));
      }
    });

    test('editing a managed MeshAgent template does not change an existing member or runtime identity', async () => {
      const projectDir = join(dir, 'project-member-rename');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockMeshAgent(t, dir, {
        agentName: 'codex'
      });
      const projectId = await createWorkplaceProject(t, projectDir);
      const sessionId = await createProjectSession(t, projectId, projectDir);
      await setMemberTemplates(t, projectId, [
        meshAgentTemplate('pmem_codex_reviewer', 'codex', { managedProjectAgent: true }, 'Reviewer')
      ]);
      const member = await inviteMember(t, sessionId, 'pmem_codex_reviewer');
      await waitForValue(
        () =>
          handlers.store
            .listMeshSessionsForTranscriptTarget(sessionId)
            .find((candidate) => candidate.runtimeRole === 'managed-project-agent'),
        'managed project member runtime'
      );

      await setMemberTemplates(t, projectId, [
        meshAgentTemplate('pmem_codex_reviewer', 'codex', { managedProjectAgent: true }, 'Renamed reviewer')
      ]);

      const send = await t.fetch(`/v1/channels/${sessionId}/messages`, json('POST', { text: 'after rename task' }));
      expect(send.status).toBe(200);
      const input = await waitForFile(stdinLog, 'after rename task');
      expect(managedIngressBatches(input).flatMap((batch) => batch.messages.map((message) => message.text))).toEqual([
        'after rename task'
      ]);

      const sessions = handlers.store
        .listMeshSessionsForTranscriptTarget(sessionId)
        .filter((candidate) => candidate.runtimeRole === 'managed-project-agent');
      // Runtime identity is the stable member id and existing members retain their invite-time profile snapshot.
      expect([...new Set(sessions.map((nativeSession) => nativeSession.agentName))]).toEqual([member.id]);
      const rebound = (await (await t.fetch(`/v1/sessions/${sessionId}/members/${member.id}`, json('PUT'))).json()) as {
        member: { id: string; displayName: string };
      };
      expect(rebound.member.id).toBe(member.id);
      expect(rebound.member.displayName).toBe('Reviewer');
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
      await setMemberTemplates(t, projectId, [meshAgentTemplate('codex', 'codex', {})]);
      await inviteMember(t, sessionId, 'codex');

      const send = await t.fetch(`/v1/channels/${sessionId}/messages`, json('POST', { text: 'please review this' }));
      expect(send.status).toBe(200);
      expect(await send.json()).toEqual({ accepted: true });
      const input = await waitForFile(stdinLog, 'please review this');
      const messagesForAgent = managedIngressBatches(input).flatMap((batch) => batch.messages);
      expect(messagesForAgent.map(({ sender, source, text }) => ({ sender, source, text }))).toContainEqual({
        sender: { kind: 'human', name: 'zeke', id: 'human' },
        source: 'project',
        text: 'please review this'
      });
      const notice = input.slice(input.lastIndexOf('Process this single managed project inbox batch.'));
      expect(notice).not.toContain('Your display name:');
      expect(notice).not.toContain('Your runtime agent id:');
      expect(notice).not.toContain('Template agent:');
      expect(notice).not.toContain('Provider:');
      const envText = await waitForFile(envLog, TEST_MESH_AGENT_SERVER_URL);
      expect(JSON.parse(envText.trim().split(/\n/).at(-1) ?? '{}')).toMatchObject({
        MONAD_SERVER_URL: TEST_MESH_AGENT_SERVER_URL
      });
      const messages = await waitForTextMessages(t, sessionId, 1);
      expect(messages.map((message) => [message.role, message.text])).toEqual([['user', 'please review this']]);
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
      if (!nativeSession) throw new Error('managed MeshAgent session was not started');
      // The managed mesh cursor is frozen; delivery progress lives on the SessionBinding watermark.
      const cursor = handlers.store.meshAgentInboxCursor(nativeSession.id);
      expect(cursor.deliveredSeq).toBeGreaterThan(0);
      expect(cursor.visibleSeq).toBe(cursor.deliveredSeq);
      expect(handlers.store.listMeshAgentInbox(nativeSession.id)).toEqual([]);
      expect(await comparablePath(nativeSession.workingPath)).toBe(await comparablePath(projectDir));
      const agentWorkspace = join(
        makePaths(dir).home,
        'workplace',
        projectId,
        'runtime',
        sessionId,
        nativeSession.agentName
      );
      expect(await readFile(join(agentWorkspace, '.monad-agent-token'), 'utf8')).not.toBe('');
      await t.fetch(`/v1/mesh/sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`, json('POST'));
      expect(await readFile(join(agentWorkspace, '.monad-agent-token'), 'utf8').catch(() => null)).toBeNull();
      const projectMemory = join(makePaths(dir).home, 'workplace', projectId, 'shared', 'MEMORY.md');
      expect(await readFile(projectMemory, 'utf8')).toContain('Project memory index');
    });

    test('managed MeshAgent project member resumes a stored provider session ref', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { argsLog } = await configureMockMeshAgent(t, dir, {
        agentName: 'claude',
        authState: 'unknown'
      });
      // Keep the provider unavailable while the member identity is created, then seed the prior
      // stopped runtime for that stable identity before making the provider ready.
      const projectId = await createWorkplaceProject(t);
      const sessionId = await createProjectSession(t, projectId);
      await setMemberTemplates(t, projectId, [meshAgentTemplate('claude', 'claude', { managedProjectAgent: true })]);
      const member = await inviteMember(t, sessionId, 'claude');
      handlers.store.upsertMeshSession({
        id: 'mesh_oldclaude000',
        transcriptTargetId: sessionId,
        agentName: member.id,
        provider: 'claude-code',
        workingPath: projectDir,
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
      // Stamp the seeded runtime's owning ProjectMember the way a real start does (upsertMeshSession cannot
      // set project_member_id) so the resume lookup, now keyed by projectMemberId, can find it.
      handlers.store.replaceSessionBindingRuntime({
        sessionId,
        projectMemberId: member.id,
        currentNativeRuntimeSessionId: 'mesh_oldclaude000' as MeshSessionId,
        updatedAt: '2026-06-30T00:00:01.000Z'
      });
      await t.fetch(`/v1/sessions/${sessionId}`, json('PATCH', { cwd: projectDir }));
      await configureMockMeshAgent(t, dir, { agentName: 'claude' });

      const send = await t.fetch(`/v1/channels/${sessionId}/messages`, json('POST', { text: 'resume this task' }));
      expect(send.status).toBe(200);

      const args = await waitForFile(argsLog, '--resume claude-session-resume');
      expect(args).toContain('--append-system-prompt-file');
      const resumed = handlers.store
        .listMeshSessionsForTranscriptTarget(sessionId)
        .find((candidate) => candidate.agentName === member.id && candidate.state === 'running');
      expect(resumed?.providerSessionRef).toBe('claude-session-resume');
      if (resumed) await t.fetch(`/v1/mesh/sessions/${resumed.id}/stop?transcriptTargetId=${sessionId}`, json('POST'));
    });

    test('managed member autopilot controls native provider approval flags', async () => {
      const projectDir = join(dir, 'project-autopilot');
      await mkdir(projectDir, { recursive: true });
      const autopilotAgent = await configureMockMeshAgent(t, dir, {
        agentName: 'claude-auto',
        provider: 'claude-code'
      });
      const delegatedAgent = await configureMockMeshAgent(t, dir, {
        agentName: 'claude-delegated',
        provider: 'claude-code'
      });

      const autopilotProjectId = await createWorkplaceProject(t, projectDir);
      const autopilotSessionId = await createProjectSession(t, autopilotProjectId, projectDir);
      await setMemberTemplates(t, autopilotProjectId, [
        meshAgentTemplate('claude-auto', 'claude-auto', {
          managedProjectAgent: true,
          allowAutopilot: true
        })
      ]);
      await inviteMember(t, autopilotSessionId, 'claude-auto');
      const autopilotSend = await t.fetch(
        `/v1/channels/${autopilotSessionId}/messages`,
        json('POST', { text: 'run without interactive approvals' })
      );
      expect(autopilotSend.status).toBe(200);
      const autopilotArgs = await waitForFile(autopilotAgent.argsLog, '--dangerously-skip-permissions', 400);
      const [autopilotNativeSession] = handlers.store.listMeshSessionsForTranscriptTarget(autopilotSessionId);
      if (autopilotNativeSession) {
        await t.fetch(
          `/v1/mesh/sessions/${autopilotNativeSession.id}/stop?transcriptTargetId=${autopilotSessionId}`,
          json('POST')
        );
      }

      const delegatedProjectId = await createWorkplaceProject(t, projectDir);
      const delegatedSessionId = await createProjectSession(t, delegatedProjectId, projectDir);
      await setMemberTemplates(t, delegatedProjectId, [
        meshAgentTemplate('claude-delegated', 'claude-delegated', {
          managedProjectAgent: true,
          allowAutopilot: false
        })
      ]);
      await inviteMember(t, delegatedSessionId, 'claude-delegated');
      const delegatedSend = await t.fetch(
        `/v1/channels/${delegatedSessionId}/messages`,
        json('POST', { text: 'delegate interactive approvals' })
      );
      expect(delegatedSend.status).toBe(200);
      const delegatedArgs = await waitForFile(delegatedAgent.argsLog, '--append-system-prompt-file', 400);
      const [delegatedNativeSession] = handlers.store.listMeshSessionsForTranscriptTarget(delegatedSessionId);
      if (delegatedNativeSession) {
        await t.fetch(
          `/v1/mesh/sessions/${delegatedNativeSession.id}/stop?transcriptTargetId=${delegatedSessionId}`,
          json('POST')
        );
      }

      const approvalFlags = (value: string) =>
        value
          .trim()
          .split(/\s+/)
          .filter((arg) => arg === '--dangerously-skip-permissions');
      expect({
        autopilot: approvalFlags(autopilotArgs),
        delegated: approvalFlags(delegatedArgs)
      }).toEqual({
        autopilot: ['--dangerously-skip-permissions'],
        delegated: []
      });
    }, 20_000);

    test('managed MeshAgent project member requires Studio reconnect when provider auth is unauthenticated', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockMeshAgent(t, dir, {
        authState: 'unauthenticated'
      });
      const projectId = await createWorkplaceProject(t, projectDir);
      const sessionId = await createProjectSession(t, projectId, projectDir);
      await setMemberTemplates(t, projectId, [meshAgentTemplate('codex', 'codex', { managedProjectAgent: true })]);

      const eventsP = t.sse(`/v1/sessions/${sessionId}/events`, {
        until: (event) => event.type === 'mesh.connection_required',
        timeoutMs: 3000
      });
      const member = await inviteMember(t, sessionId, 'codex');
      const send = await t.fetch(`/v1/channels/${sessionId}/messages`, json('POST', { text: 'please review this' }));
      expect(send.status).toBe(200);
      expect(await send.json()).toEqual({ accepted: true });

      const events = await eventsP;
      expect(events.at(-1)?.payload).toMatchObject({
        agentName: member.id,
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

    test('managed MeshAgent project posts return before the strictly mentioned peer finishes', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog: codexStdinLog } = await configureMockMeshAgent(t, dir, {
        agentName: 'codex'
      });
      const { stdinLog: claudeStdinLog } = await configureMockMeshAgent(t, dir, { agentName: 'claude' });
      const { stdinLog: reviewerStdinLog } = await configureMockMeshAgent(t, dir, { agentName: 'reviewer' });
      const projectId = await createWorkplaceProject(t, projectDir);
      const sessionId = await createProjectSession(t, projectId, projectDir);
      await setMemberTemplates(t, projectId, [
        meshAgentTemplate('codex', 'codex', { managedProjectAgent: true }),
        meshAgentTemplate('claude', 'claude', { managedProjectAgent: true }),
        meshAgentTemplate('reviewer', 'reviewer', { managedProjectAgent: true })
      ]);
      const codexMember = await inviteMember(t, sessionId, 'codex');
      const claudeMember = await inviteMember(t, sessionId, 'claude');
      await inviteMember(t, sessionId, 'reviewer');

      const send = await t.fetch(`/v1/channels/${sessionId}/messages`, json('POST', { text: 'initial project task' }));
      expect(send.status).toBe(200);
      await waitForFile(codexStdinLog, 'initial project task');
      await waitForFile(claudeStdinLog, 'initial project task');
      await waitForFile(reviewerStdinLog, 'initial project task');

      const nativeSessions = handlers.store.listMeshSessionsForTranscriptTarget(sessionId);
      const codexSession = nativeSessions.find((candidate) => candidate.agentName === codexMember.id);
      const claudeSession = nativeSessions.find((candidate) => candidate.agentName === claudeMember.id);
      const reviewerSession = nativeSessions.find(
        (candidate) => candidate.agentName !== codexMember.id && candidate.agentName !== claudeMember.id
      );
      expect(typeof codexSession?.id).toBe('string');
      if (!codexSession) throw new Error('codex managed MeshAgent session was not started');
      if (!claudeSession) throw new Error('claude managed MeshAgent session was not started');
      if (!reviewerSession) throw new Error('reviewer managed MeshAgent session was not started');
      const codexToken = await readFile(
        join(makePaths(dir).home, 'workplace', projectId, 'runtime', sessionId, codexMember.id, '.monad-agent-token'),
        'utf8'
      );

      const initialMessage = handlers.store
        .listMessages(sessionId, { latest: true })
        .find((message) => message.role === 'user' && message.text === 'initial project task');
      if (!initialMessage) throw new Error('initial project message was not persisted');

      await t.fetch(`/v1/mesh/sessions/${claudeSession.id}/stop?transcriptTargetId=${sessionId}`, json('POST'));
      await t.fetch(`/v1/mesh/sessions/${reviewerSession.id}/stop?transcriptTargetId=${sessionId}`, json('POST'));
      await configureMockMeshAgent(t, dir, {
        agentName: 'claude',
        turnDelayMs: 15_000
      });
      const claudeInputBeforePost = await readLogIfExists(claudeStdinLog);
      const reviewerInputBeforePost = await readLogIfExists(reviewerStdinLog);

      const mentionedText = '@[name="Claude" id="claude"] please inspect this';
      const abort = new AbortController();
      const postResult = t
        .fetch('/v1/internal/native-agent/project/post', {
          ...json(
            'POST',
            {
              requestId: 'channel-routing-mentioned-post',
              projectId: sessionId,
              text: mentionedText,
              replyToMessageId: initialMessage.id
            },
            managedBindingHeaders(sessionId, codexSession.id, 'codex', codexToken)
          ),
          signal: abort.signal
        })
        .then(
          (response) => ({ kind: 'response' as const, response }),
          (error: unknown) => ({ kind: 'error' as const, error })
        );
      const responseOrTimeout = await Promise.race([
        postResult,
        Bun.sleep(5_000).then(() => ({ kind: 'timeout' as const }))
      ]);
      if (responseOrTimeout.kind === 'timeout') abort.abort();
      expect(responseOrTimeout.kind).toBe('response');
      if (responseOrTimeout.kind !== 'response') throw new Error('project post did not return promptly');
      expect(responseOrTimeout.response.status).toBe(200);
      expect(await responseOrTimeout.response.json()).toEqual({
        ok: true,
        message: {
          id: expect.stringMatching(/^msg_/),
          sessionId,
          text: mentionedText,
          replyToMessageId: initialMessage.id,
          createdAt: expect.any(String)
        }
      });

      const claudeInput = await waitForFile(claudeStdinLog, 'please inspect this');
      expect(
        managedIngressBatches(claudeInput)
          .flatMap((batch) => batch.messages)
          .map(({ replyToMessageId, sender, text }) => ({ replyToMessageId, sender, text }))
      ).toContainEqual({
        replyToMessageId: initialMessage.id,
        sender: { id: codexMember.id, kind: 'mesh-agent', name: 'codex' },
        text: mentionedText
      });
      await Bun.sleep(100);
      // presence-ok: a strict managed-agent mention targets Claude, so the unrelated reviewer receives no input.
      expect(await readLogIfExists(reviewerStdinLog)).toBe(reviewerInputBeforePost);

      const unmentionedText = 'codex public update';
      const post = await t.fetch(
        '/v1/internal/native-agent/project/post',
        json(
          'POST',
          { requestId: 'channel-routing-unmentioned-post', projectId: sessionId, text: unmentionedText },
          managedBindingHeaders(sessionId, codexSession.id, 'codex', codexToken)
        )
      );
      if (post.status !== 200) throw new Error(await post.text());
      expect(await post.json()).toEqual({
        ok: true,
        message: {
          id: expect.stringMatching(/^msg_/),
          sessionId,
          text: unmentionedText,
          createdAt: expect.any(String)
        }
      });
      await Bun.sleep(100);
      expect(await readLogIfExists(reviewerStdinLog)).toBe(reviewerInputBeforePost);
      expect(await readLogIfExists(claudeStdinLog)).toBe(claudeInput);
      expect(claudeInput).not.toBe(claudeInputBeforePost);
      const transcriptMessages = handlers.store
        .listMessages(sessionId, { latest: true })
        .filter((message) => message.text)
        .map(({ replyToMessageId, role, text }) => ({ replyToMessageId, role, text }));
      expect(transcriptMessages).toEqual([
        { replyToMessageId: undefined, role: 'user', text: 'initial project task' },
        {
          replyToMessageId: initialMessage.id,
          role: 'assistant',
          text: mentionedText
        },
        { replyToMessageId: undefined, role: 'assistant', text: unmentionedText }
      ]);

      const direct = await t.fetch(
        '/v1/internal/native-agent/agent/send',
        json(
          'POST',
          { requestId: 'channel-routing-direct-send', to: 'claude', text: 'codex private note' },
          managedBindingHeaders(sessionId, codexSession.id, 'codex', codexToken)
        )
      );
      if (direct.status !== 200) throw new Error(await direct.text());
      expect(direct.status).toBe(200);
      const directBody = (await direct.clone().json()) as { message: unknown };
      const directNotice = await waitForFile(claudeStdinLog, 'codex private note');
      expect(
        managedIngressBatches(directNotice)
          .flatMap((batch) => batch.messages)
          .map(({ fromAgent, peer, source, text }) => ({ fromAgent, peer, source, text }))
      ).toContainEqual({
        fromAgent: codexMember.id,
        peer: claudeMember.id,
        source: 'direct',
        text: 'codex private note'
      });
      const recordedMessages = await waitForValue(() => {
        const messages = handlers.store.listMessages(sessionId, { latest: true }).filter((message) => message.text);
        return messages.length === 4 ? messages : undefined;
      }, 'managed direct-message transcript entry');
      expect(recordedMessages.map(({ role, text, type }) => ({ role, text, type }))).toEqual([
        { role: 'user', text: 'initial project task', type: 'text' },
        { role: 'assistant', text: mentionedText, type: 'text' },
        { role: 'assistant', text: unmentionedText, type: 'text' },
        { role: 'assistant', text: 'codex sent claude a DM.', type: 'mesh_agent_direct_message' }
      ]);
      expect(recordedMessages.at(-1)?.data).toEqual({ message: directBody.message });

      for (const nativeSession of handlers.store.listMeshSessionsForTranscriptTarget(sessionId)) {
        await t.fetch(`/v1/mesh/sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`, json('POST'));
      }
    }, 20_000);

    test('project fan-out shows transient login cards for each unauthenticated managed member', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog: codexStdinLog } = await configureMockMeshAgent(t, dir, {
        agentName: 'codex'
      });
      const { stdinLog: claudeStdinLog } = await configureMockMeshAgent(t, dir, {
        agentName: 'claude-code',
        authState: 'unauthenticated'
      });
      const projectId = await createWorkplaceProject(t, projectDir);
      const sessionId = await createProjectSession(t, projectId, projectDir);
      await setMemberTemplates(t, projectId, [
        meshAgentTemplate('pmem_codex', 'codex', { managedProjectAgent: true }, 'Codex'),
        meshAgentTemplate('pmem_claude_opus', 'claude-code', { managedProjectAgent: true, modelId: 'opus' }, 'Opus'),
        meshAgentTemplate(
          'pmem_claude_sonnet',
          'claude-code',
          { managedProjectAgent: true, modelId: 'sonnet' },
          'Sonnet'
        )
      ]);
      let codexJoinSettled = false;
      const disposeCodexJoinEvents = handlers.bus.subscribe(sessionId, (event) => {
        if (event.type === 'mesh.turn_settled') codexJoinSettled = true;
      });
      await inviteMember(t, sessionId, 'pmem_codex');
      await waitFor(() => codexJoinSettled, { message: 'authenticated member join turn did not settle' });
      disposeCodexJoinEvents();
      const opus = await inviteMember(t, sessionId, 'pmem_claude_opus');
      const sonnet = await inviteMember(t, sessionId, 'pmem_claude_sonnet');
      const loginAgents = new Set<string>();
      const loginFramesP = t.sse(`/v1/sessions/${sessionId}/mesh-state/stream`, {
        until: (frame) => {
          for (const login of meshLoginRequirements(frame as unknown as MeshAgentStateFrame)) {
            loginAgents.add(login.agentName);
          }
          return loginAgents.has(opus.id) && loginAgents.has(sonnet.id);
        },
        timeoutMs: 3000
      });

      const send = await t.fetch(`/v1/channels/${sessionId}/messages`, json('POST', { text: 'initial project task' }));
      expect(send.status).toBe(200);
      await waitForFile(codexStdinLog, 'initial project task');

      const loginFrames = (await loginFramesP) as unknown as MeshAgentStateFrame[];
      const loginByAgent = new Map(
        loginFrames.flatMap((frame) => meshLoginRequirements(frame)).map((login) => [login.agentName, login])
      );
      expect([...loginByAgent.values()].toSorted((a, b) => a.agentName.localeCompare(b.agentName))).toEqual(
        [
          { agentName: opus.id, provider: 'claude-code' },
          { agentName: sonnet.id, provider: 'claude-code' }
        ].toSorted((a, b) => a.agentName.localeCompare(b.agentName))
      );

      // A fresh subscribe folds the same pending login requirements into its authoritative snapshot.
      const freshFrames = (await t.sse(`/v1/sessions/${sessionId}/mesh-state/stream`, {
        until: (frame) => (frame as unknown as MeshAgentStateFrame).kind === 'snapshot',
        timeoutMs: 3000
      })) as unknown as MeshAgentStateFrame[];
      const freshSnapshot = freshFrames.find((frame) => frame.kind === 'snapshot');
      const snapshotLoginAgents =
        freshSnapshot?.kind === 'snapshot'
          ? freshSnapshot.loginRequirements.map((login) => login.agentName).toSorted()
          : [];
      expect(snapshotLoginAgents).toEqual([opus.id, sonnet.id].toSorted());
      expect(await readLogIfExists(claudeStdinLog)).toBe('');
      await waitFor(
        async () =>
          (await listMessages(t, sessionId)).every((message) => message.role !== 'assistant' || message.text !== ''),
        { message: 'authenticated member placeholder did not settle' }
      );
      expect((await listMessages(t, sessionId)).map((message) => [message.role, message.text])).toEqual([
        ['user', 'initial project task']
      ]);
    }, 20_000);

    test('single-member project mention reaches the managed MeshAgent through room fanout', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockMeshAgent(t, dir);
      const projectId = await createWorkplaceProject(t, projectDir);
      const sessionId = await createProjectSession(t, projectId, projectDir);
      await setMemberTemplates(t, projectId, [meshAgentTemplate('codex', 'codex', { managedProjectAgent: true })]);
      const member = await inviteMember(t, sessionId, 'codex');

      const eventsP = t.sse(`/v1/sessions/${sessionId}/events`, {
        until: (event) =>
          event.type === 'mesh.started' && (event.payload as { agentName?: unknown }).agentName === member.id,
        timeoutMs: 3000
      });
      const send = await t.fetch(
        `/v1/channels/${sessionId}/messages`,
        json('POST', {
          text: '@[name="codex" id="mesh-agent:codex"] inspect repo'
        })
      );
      if (send.status !== 200) throw new Error(await send.text());
      expect(send.status).toBe(200);
      expect(await send.json()).toEqual({ accepted: true });

      expect(await waitForFile(stdinLog, 'inspect repo')).toContain('inspect repo');
      const messages = await waitForTextMessages(t, sessionId, 1);
      expect(messages.map(({ role, text }) => ({ role, text }))).toEqual([
        {
          role: 'user',
          text: '@[name="codex" id="mesh-agent:codex"] inspect repo'
        }
      ]);
      const events = await eventsP;
      expect(events.some((event) => event.type === 'mesh.started' && event.payload.agentName === member.id)).toBe(true);
      const listed = await t.fetch(`/v1/mesh/sessions?transcriptTargetId=${sessionId}`);
      expect(listed.status).toBe(200);
      const nativeSessionId = ((await listed.json()) as { sessions: Array<{ id: string }> }).sessions[0]?.id;
      expect(typeof nativeSessionId).toBe('string');
      await t.fetch(`/v1/mesh/sessions/${nativeSessionId}/stop?transcriptTargetId=${sessionId}`, json('POST'));
    });

    test('project member id mention fans out to every managed MeshAgent member', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockMeshAgent(t, dir);
      const projectId = await createWorkplaceProject(t, projectDir);
      const sessionId = await createProjectSession(t, projectId, projectDir);
      await setMemberTemplates(t, projectId, [
        meshAgentTemplate('pmem_codex_reviewer', 'codex', { managedProjectAgent: true }, 'Reviewer'),
        meshAgentTemplate('pmem_codex_tester', 'codex', { managedProjectAgent: true }, 'Tester')
      ]);
      const reviewer = await inviteMember(t, sessionId, 'pmem_codex_reviewer');
      const tester = await inviteMember(t, sessionId, 'pmem_codex_tester');
      const initialSessionsRes = await t.fetch(`/v1/mesh/sessions?transcriptTargetId=${sessionId}`);
      expect(initialSessionsRes.status).toBe(200);
      const initialSessions = (await initialSessionsRes.json()) as {
        sessions: Array<{ id: string }>;
      };
      for (const nativeSession of initialSessions.sessions) {
        await t.fetch(`/v1/mesh/sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`, json('POST'));
      }

      const eventsP = t.sse(`/v1/sessions/${sessionId}/events`, {
        until: (event) =>
          event.type === 'mesh.started' && (event.payload as { agentName?: unknown }).agentName === tester.id,
        timeoutMs: 3000
      });
      const send = await t.fetch(
        `/v1/channels/${sessionId}/messages`,
        json('POST', {
          text: `@[name="Tester" id="${tester.id}"] coordinate now`
        })
      );
      if (send.status !== 200) throw new Error(await send.text());
      expect(await send.json()).toEqual({ accepted: true });

      expect(await waitForFile(stdinLog, 'coordinate now')).toContain('coordinate now');
      await eventsP;
      let sessions: Array<{
        id: string;
        agentName: string;
        lifecycle: { state: string };
      }> = [];
      const activeAgentNames = () =>
        sessions
          .filter((nativeSession) => nativeSession.lifecycle.state === 'active')
          .map((nativeSession) => nativeSession.agentName)
          .toSorted();
      for (let i = 0; i < 20; i++) {
        const listed = await t.fetch(`/v1/mesh/sessions?transcriptTargetId=${sessionId}`);
        expect(listed.status).toBe(200);
        const body = (await listed.json()) as {
          sessions: Array<{
            id: string;
            agentName: string;
            lifecycle: { state: string };
          }>;
        };
        sessions = body.sessions;
        if (activeAgentNames().length === 2) break;
        await Bun.sleep(25);
      }
      expect(activeAgentNames()).toEqual([reviewer.id, tester.id].toSorted());
      expect(
        (await listMessages(t, sessionId)).filter(({ text }) => text).map(({ role, text }) => ({ role, text }))
      ).toEqual([
        {
          role: 'user',
          text: `@[name="Tester" id="${tester.id}"] coordinate now`
        }
      ]);
      for (const nativeSession of sessions) {
        await t.fetch(`/v1/mesh/sessions/${nativeSession.id}/stop?transcriptTargetId=${sessionId}`, json('POST'));
      }
    });

    test('project mention fanout requires Studio reconnect when provider auth status is unauthenticated', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockMeshAgent(t, dir, {
        authState: 'unauthenticated'
      });
      const projectId = await createWorkplaceProject(t, projectDir);
      const sessionId = await createProjectSession(t, projectId, projectDir);
      await setMemberTemplates(t, projectId, [meshAgentTemplate('codex', 'codex', { managedProjectAgent: true })]);
      const member = await inviteMember(t, sessionId, 'codex');

      const eventsP = t.sse(`/v1/sessions/${sessionId}/events`, {
        until: (event) => event.type === 'mesh.connection_required',
        timeoutMs: 3000
      });
      const send = await t.fetch(
        `/v1/channels/${sessionId}/messages`,
        json('POST', {
          text: '@[name="codex" id="mesh-agent:codex"] inspect repo'
        })
      );
      if (send.status !== 200) throw new Error(await send.text());
      expect(send.status).toBe(200);
      expect(await send.json()).toEqual({ accepted: true });

      const events = await eventsP;
      expect(events.at(-1)?.payload).toMatchObject({
        agentName: member.id,
        provider: 'codex',
        reconnectIn: 'studio'
      });
      const stdinText = await readFile(stdinLog, 'utf8').catch(() => '');
      expect(stdinText).toBe('');
      expect((await listMessages(t, sessionId)).map(({ role, text }) => ({ role, text }))).toEqual([
        {
          role: 'user',
          text: '@[name="codex" id="mesh-agent:codex"] inspect repo'
        }
      ]);
    });

    test('project mention fanout requires Studio check when provider readiness is unknown', async () => {
      const projectDir = join(dir, 'project');
      await mkdir(projectDir, { recursive: true });
      const { stdinLog } = await configureMockMeshAgent(t, dir, {
        authState: 'unknown'
      });
      const projectId = await createWorkplaceProject(t, projectDir);
      const sessionId = await createProjectSession(t, projectId, projectDir);
      await setMemberTemplates(t, projectId, [meshAgentTemplate('codex', 'codex', { managedProjectAgent: true })]);
      await inviteMember(t, sessionId, 'codex');

      const send = await t.fetch(
        `/v1/channels/${sessionId}/messages`,
        json('POST', {
          text: '@[name="codex" id="mesh-agent:codex"] inspect repo'
        })
      );
      if (send.status !== 200) throw new Error(await send.text());
      expect(await send.json()).toEqual({ accepted: true });

      const stdinText = await readFile(stdinLog, 'utf8').catch(() => '');
      expect(stdinText).toBe('');
      expect((await listMessages(t, sessionId)).map(({ role, text }) => ({ role, text }))).toEqual([
        {
          role: 'user',
          text: '@[name="codex" id="mesh-agent:codex"] inspect repo'
        }
      ]);
    });

    test('project fanout without a session cwd uses the member working directory', async () => {
      const memberDir = join(dir, 'member-workspace');
      await mkdir(memberDir, { recursive: true });
      const { stdinLog } = await configureMockMeshAgent(t, dir);
      const projectId = await createWorkplaceProject(t);
      const sessionId = await createProjectSession(t, projectId);
      await setMemberTemplates(t, projectId, [
        meshAgentTemplate('codex', 'codex', { cwd: memberDir, managedProjectAgent: true })
      ]);
      await inviteMember(t, sessionId, 'codex');
      const send = await t.fetch(
        `/v1/channels/${sessionId}/messages`,
        json('POST', {
          text: '@[name="codex" id="mesh-agent:codex"] inspect repo'
        })
      );
      expect(send.status).toBe(200);
      expect(await send.json()).toEqual({ accepted: true });

      const input = await waitForFile(stdinLog, 'inspect repo');
      expect(managedIngressBatches(input).flatMap((batch) => batch.messages.map((message) => message.text))).toEqual([
        '@[name="codex" id="mesh-agent:codex"] inspect repo'
      ]);
      const nativeSession = await waitForValue(
        () =>
          handlers.store
            .listMeshSessionsForTranscriptTarget(sessionId)
            .find((candidate) => candidate.runtimeRole === 'managed-project-agent'),
        'managed project member runtime'
      );
      expect(await comparablePath(nativeSession.workingPath)).toBe(await comparablePath(memberDir));
    });

    test('project fanout without any configured cwd uses the project shared workspace', async () => {
      const { stdinLog } = await configureMockMeshAgent(t, dir);
      const projectId = await createWorkplaceProject(t);
      const sessionId = await createProjectSession(t, projectId);
      await setMemberTemplates(t, projectId, [meshAgentTemplate('codex', 'codex', { managedProjectAgent: true })]);
      await inviteMember(t, sessionId, 'codex');

      const send = await t.fetch(
        `/v1/channels/${sessionId}/messages`,
        json('POST', {
          text: '@[name="codex" id="mesh-agent:codex"] inspect shared workspace'
        })
      );
      expect(send.status).toBe(200);
      expect(await send.json()).toEqual({ accepted: true });

      const input = await waitForFile(stdinLog, 'inspect shared workspace');
      expect(managedIngressBatches(input).flatMap((batch) => batch.messages.map((message) => message.text))).toEqual([
        '@[name="codex" id="mesh-agent:codex"] inspect shared workspace'
      ]);
      const nativeSession = await waitForValue(
        () =>
          handlers.store
            .listMeshSessionsForTranscriptTarget(sessionId)
            .find((candidate) => candidate.runtimeRole === 'managed-project-agent'),
        'managed project member runtime'
      );
      expect(await comparablePath(nativeSession.workingPath)).toBe(
        await comparablePath(join(makePaths(dir).home, 'workplace', projectId, 'shared'))
      );
    });
  });
}
