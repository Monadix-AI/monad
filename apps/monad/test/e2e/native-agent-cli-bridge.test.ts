import type { SessionId } from '@monad/protocol';

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHttpTransport } from '@/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, TRANSPORTS, type TransportHandle } from '../helpers.ts';

const AGENT_TOKEN = 'managed-agent-token';

const tokenHash = (token = AGENT_TOKEN): string => createHash('sha256').update(token).digest('hex');

const json = (body: unknown, headers?: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

async function responseError(res: Response): Promise<{ error?: string; code?: string }> {
  return (await res.json().catch(() => ({}))) as { error?: string; code?: string };
}

async function createSession(t: TransportHandle): Promise<SessionId> {
  const res = await t.fetch('/v1/sessions', json({ title: 'Workplace: managed native agent' }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { sessionId: SessionId }).sessionId;
}

async function messages(t: TransportHandle, sessionId: SessionId): Promise<Array<{ role: string; text: string }>> {
  const res = await t.fetch(`/v1/sessions/${sessionId}/messages`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { messages: Array<{ role: string; text: string }> }).messages.map(({ role, text }) => ({
    role,
    text
  }));
}

function bindingHeaders(
  _sessionId: SessionId,
  nativeCliSessionId = 'ncli_test',
  _agentId = 'codex'
): Record<string, string> {
  return {
    authorization: `Bearer ${AGENT_TOKEN}`,
    'x-monad-native-cli-session-id': nativeCliSessionId
  };
}

function createManagedNativeSession(
  handlers: ReturnType<typeof buildHandlers>,
  sessionId: SessionId,
  id = 'ncli_test',
  agentName = 'codex',
  state: 'running' | 'stopped' = 'running'
): void {
  handlers.store.upsertNativeCliSession({
    id,
    projectSessionId: sessionId,
    agentName,
    provider: agentName === 'claude' ? 'claude-code' : 'codex',
    workingPath: '/tmp/project',
    launchMode: 'app-server',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: id,
    agentRuntimeTokenHash: tokenHash(),
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    state,
    pid: state === 'running' ? 123 : null,
    providerSessionRef: null,
    outputSnapshot: '',
    exitCode: null,
    startedAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
    exitedAt: state === 'running' ? null : '2026-06-30T00:00:01.000Z'
  });
}

for (const kind of TRANSPORTS) {
  describe(`native agent CLI bridge over ${kind}`, () => {
    let t: TransportHandle;

    afterEach(async () => {
      await t?.stop();
    });

    test('project post writes the Workplace Project transcript', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId);

      const res = await t.fetch(
        '/v1/internal/native-agent/project/post',
        json({ projectId: sessionId, text: 'managed reply' }, bindingHeaders(sessionId))
      );

      expect(res.status).toBe(200);
      expect(await messages(t, sessionId)).toEqual([{ role: 'assistant', text: 'managed reply' }]);
    });

    test('agent send stays out of the Workplace Project transcript', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId);

      const res = await t.fetch(
        '/v1/internal/native-agent/agent/send',
        json({ to: 'human:zeke', text: 'private note' }, bindingHeaders(sessionId))
      );

      expect(res.status).toBe(200);
      expect(await messages(t, sessionId)).toEqual([]);
    });

    test('agent send and read use a direct private ledger', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId);

      const sent = await t.fetch(
        '/v1/internal/native-agent/agent/send',
        json({ to: 'human:zeke', text: 'private note' }, bindingHeaders(sessionId))
      );
      expect(sent.status).toBe(200);

      const read = await t.fetch(
        '/v1/internal/native-agent/agent/read',
        json({ with: 'human:zeke' }, bindingHeaders(sessionId))
      );

      expect(read.status).toBe(200);
      expect(((await read.json()) as { messages: Array<{ peer: string; text: string }> }).messages).toMatchObject([
        { peer: 'human:zeke', text: 'private note' }
      ]);
      expect(await messages(t, sessionId)).toEqual([]);
    });

    test('direct private ledger is readable from both managed agent runtimes in the same project', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId, 'ncli_codex', 'codex');
      createManagedNativeSession(handlers, sessionId, 'ncli_claude', 'claude');

      const sent = await t.fetch(
        '/v1/internal/native-agent/agent/send',
        json({ to: 'claude', text: 'private handoff' }, bindingHeaders(sessionId, 'ncli_codex', 'codex'))
      );
      expect(sent.status).toBe(200);

      const readByClaude = await t.fetch(
        '/v1/internal/native-agent/agent/read',
        json({ with: 'codex' }, bindingHeaders(sessionId, 'ncli_claude', 'claude'))
      );

      expect(readByClaude.status).toBe(200);
      expect(
        ((await readByClaude.json()) as { messages: Array<{ fromAgent: string; peer: string; text: string }> }).messages
      ).toMatchObject([{ fromAgent: 'codex', peer: 'claude', text: 'private handoff' }]);
      expect(await messages(t, sessionId)).toEqual([]);
    });

    test('project read can return a single project thread', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId);
      handlers.store.insertMessage('msg_ROOT', sessionId, 'root issue', '2026-06-30T00:00:01.000Z', 'user');
      handlers.store.insertMessage(
        'msg_THREADREPLY',
        sessionId,
        'thread reply',
        '2026-06-30T00:00:02.000Z',
        'assistant',
        { data: { threadId: 'msg_ROOT', agentName: 'codex' } }
      );
      handlers.store.insertMessage('msg_OTHER', sessionId, 'unrelated', '2026-06-30T00:00:03.000Z', 'user');

      const read = await t.fetch(
        '/v1/internal/native-agent/project/read',
        json({ projectId: sessionId, threadId: 'msg_ROOT' }, bindingHeaders(sessionId))
      );

      expect(read.status).toBe(200);
      expect(
        ((await read.json()) as { messages: Array<{ text: string }> }).messages.map((message) => message.text)
      ).toEqual(['root issue', 'thread reply']);

      const inbox = await t.fetch(
        '/v1/internal/native-agent/project/inbox',
        json({ projectId: sessionId }, bindingHeaders(sessionId))
      );
      expect(inbox.status).toBe(200);
      expect(
        ((await inbox.json()) as { items: Array<{ message: { text: string } }> }).items.map((item) => item.message.text)
      ).toContain('unrelated');
    });

    test('project scoped commands fail outside a managed project runtime', async () => {
      t = serveTransport(kind, createHttpTransport(buildHandlers(mockModel())));
      const sessionId = await createSession(t);

      const res = await t.fetch(
        '/v1/internal/native-agent/project/post',
        json({ projectId: sessionId, text: 'should fail' })
      );

      expect(res.status).toBe(403);
      expect(await responseError(res)).toMatchObject({ code: 'NOT_MANAGED_NATIVE_CLI' });
      expect(await messages(t, sessionId)).toEqual([]);
    });

    test('project scoped commands fail when the managed runtime session is unknown', async () => {
      t = serveTransport(kind, createHttpTransport(buildHandlers(mockModel())));
      const sessionId = await createSession(t);

      const res = await t.fetch(
        '/v1/internal/native-agent/project/post',
        json({ projectId: sessionId, text: 'should fail' }, bindingHeaders(sessionId))
      );

      expect(res.status).toBe(404);
      expect(await responseError(res)).toMatchObject({ code: 'NATIVE_CLI_SESSION_NOT_FOUND' });
      expect(await messages(t, sessionId)).toEqual([]);
    });

    test('project scoped commands reject an invalid managed agent token', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId);

      const res = await t.fetch(
        '/v1/internal/native-agent/project/post',
        json(
          { projectId: sessionId, text: 'should fail' },
          { ...bindingHeaders(sessionId), authorization: 'Bearer wrong-token' }
        )
      );

      expect(res.status).toBe(403);
      expect(await responseError(res)).toMatchObject({ code: 'INVALID_NATIVE_AGENT_TOKEN' });
      expect(await messages(t, sessionId)).toEqual([]);
    });

    test('project scoped commands reject a stopped managed runtime even with its old token', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId, 'ncli_stopped', 'codex', 'stopped');

      const res = await t.fetch(
        '/v1/internal/native-agent/project/post',
        json({ projectId: sessionId, text: 'should fail' }, bindingHeaders(sessionId, 'ncli_stopped'))
      );

      expect(res.status).toBe(403);
      expect(await responseError(res)).toMatchObject({ code: 'NATIVE_CLI_SESSION_NOT_ACTIVE' });
      expect(await messages(t, sessionId)).toEqual([]);
    });

    test('project scoped commands reject a different project id', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      const otherSessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId);

      const res = await t.fetch(
        '/v1/internal/native-agent/project/post',
        json({ projectId: otherSessionId, text: 'should fail' }, bindingHeaders(sessionId))
      );

      expect(res.status).toBe(403);
      expect(await responseError(res)).toMatchObject({ code: 'PROJECT_MISMATCH' });
      expect(await messages(t, sessionId)).toEqual([]);
      expect(await messages(t, otherSessionId)).toEqual([]);
    });

    test('project inbox advances the managed native CLI visible cursor', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId, 'ncli_inbox');
      handlers.store.insertMessage('msg_INBOX1', sessionId, 'please review this', '2026-06-30T00:00:01.000Z', 'user');

      const first = await t.fetch(
        '/v1/internal/native-agent/project/inbox',
        json({ projectId: sessionId }, bindingHeaders(sessionId, 'ncli_inbox'))
      );
      expect(first.status).toBe(200);
      expect(
        ((await first.json()) as { items: Array<{ message: { text: string } }> }).items.map((item) => item.message.text)
      ).toEqual(['please review this']);

      const second = await t.fetch(
        '/v1/internal/native-agent/project/inbox',
        json({ projectId: sessionId }, bindingHeaders(sessionId, 'ncli_inbox'))
      );
      expect(second.status).toBe(200);
      expect(((await second.json()) as { items: unknown[] }).items).toEqual([]);
    });

    test('project inbox ack advances the managed native CLI visible cursor without returning messages', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId, 'ncli_ack');
      handlers.store.insertMessage('msg_ACK1', sessionId, 'ack me', '2026-06-30T00:00:01.000Z', 'user');

      const ack = await t.fetch(
        '/v1/internal/native-agent/project/inbox/ack',
        json({ projectId: sessionId }, bindingHeaders(sessionId, 'ncli_ack'))
      );
      expect(ack.status).toBe(200);

      const inbox = await t.fetch(
        '/v1/internal/native-agent/project/inbox',
        json({ projectId: sessionId }, bindingHeaders(sessionId, 'ncli_ack'))
      );
      expect(inbox.status).toBe(200);
      expect(((await inbox.json()) as { items: unknown[] }).items).toEqual([]);
    });

    test('runtime info exposes managed inbox cursor diagnostics', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId, 'ncli_runtime_info');
      handlers.store.insertMessage('msg_INFO1', sessionId, 'first pending', '2026-06-30T00:00:01.000Z', 'user');
      handlers.store.insertMessage('msg_INFO2', sessionId, 'second pending', '2026-06-30T00:00:02.000Z', 'user');
      handlers.store.setNativeCliDeliveredCursor('ncli_runtime_info', handlers.store.maxMessageSeq(sessionId));

      const res = await t.fetch('/v1/internal/native-agent/runtime/info', {
        headers: bindingHeaders(sessionId, 'ncli_runtime_info')
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        agentId: 'codex',
        projectSessionId: sessionId,
        nativeCliSessionId: 'ncli_runtime_info',
        lastDeliveredSeq: 2,
        lastVisibleSeq: 0,
        pendingInboxCount: 2
      });
    });
  });
}

describe('native agent CLI bridge real CLI process', () => {
  let t: TransportHandle | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    await t?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('monad project post writes through the typed agent-facing CLI command', async () => {
    dir = await mkdtemp(join(tmpdir(), 'monad-native-agent-cli-'));
    const handlers = buildHandlers(mockModel());
    t = serveTransport('tcp', createHttpTransport(handlers));
    if (!t.baseUrl) throw new Error('tcp transport did not expose baseUrl');
    const sessionId = await createSession(t);
    createManagedNativeSession(handlers, sessionId, 'ncli_cli');
    const tokenFile = join(dir, '.monad-agent-token');
    await writeFile(tokenFile, AGENT_TOKEN);

    const repoRoot = join(import.meta.dir, '../../../..');
    const proc = Bun.spawn(['bun', 'apps/cli/src/main.ts', 'project', 'post', 'managed reply from real cli'], {
      cwd: repoRoot,
      env: {
        ...Bun.env,
        MONAD_HOME: join(dir, 'home'),
        MONAD_SERVER_URL: t.baseUrl,
        MONAD_AGENT_TOKEN_FILE: tokenFile,
        MONAD_NATIVE_CLI_SESSION_ID: 'ncli_cli'
      },
      stdout: 'pipe',
      stderr: 'pipe'
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);

    expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });
    expect(await messages(t, sessionId)).toEqual([{ role: 'assistant', text: 'managed reply from real cli' }]);
  });

  test('monad agent send/read uses the direct private CLI command surface', async () => {
    dir = await mkdtemp(join(tmpdir(), 'monad-native-agent-cli-'));
    const handlers = buildHandlers(mockModel());
    t = serveTransport('tcp', createHttpTransport(handlers));
    if (!t.baseUrl) throw new Error('tcp transport did not expose baseUrl');
    const sessionId = await createSession(t);
    createManagedNativeSession(handlers, sessionId, 'ncli_cli', 'codex');
    createManagedNativeSession(handlers, sessionId, 'ncli_peer', 'claude');
    const tokenFile = join(dir, '.monad-agent-token');
    await writeFile(tokenFile, AGENT_TOKEN);

    const repoRoot = join(import.meta.dir, '../../../..');
    const env = {
      ...Bun.env,
      MONAD_HOME: join(dir, 'home'),
      MONAD_SERVER_URL: t.baseUrl,
      MONAD_AGENT_TOKEN_FILE: tokenFile,
      MONAD_NATIVE_CLI_SESSION_ID: 'ncli_cli'
    };
    const sent = Bun.spawn(['bun', 'apps/cli/src/main.ts', 'agent', 'send', '--to', 'claude', 'private cli note'], {
      cwd: repoRoot,
      env,
      stdout: 'pipe',
      stderr: 'pipe'
    });
    expect(await sent.exited).toBe(0);

    const read = Bun.spawn(['bun', 'apps/cli/src/main.ts', 'agent', 'read', '--with', 'claude'], {
      cwd: repoRoot,
      env,
      stdout: 'pipe',
      stderr: 'pipe'
    });
    const [stdout, exitCode] = await Promise.all([new Response(read.stdout).text(), read.exited]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('private cli note');
    expect(await messages(t, sessionId)).toEqual([]);
  });
});
