import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Event, type ProjectId, type SessionUiEvent, workplaceProjectMembersExtKey } from '@monad/protocol';

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

async function createSession(t: TransportHandle): Promise<ProjectId> {
  const res = await t.fetch('/v1/workplace/projects', json({ title: 'Workplace: managed native agent' }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { projectId: ProjectId }).projectId;
}

async function messages(t: TransportHandle, sessionId: ProjectId): Promise<Array<{ role: string; text: string }>> {
  const res = await t.fetch(`/v1/projects/${sessionId}/messages`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { messages: Array<{ role: string; text: string }> }).messages.map(({ role, text }) => ({
    role,
    text
  }));
}

function bindingHeaders(
  _sessionId: ProjectId,
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
  sessionId: ProjectId,
  id = 'ncli_test',
  agentName = 'codex',
  state: 'running' | 'stopped' = 'running',
  workingPath = '/tmp/project'
): void {
  handlers.store.upsertNativeCliSession({
    id,
    transcriptTargetId: sessionId,
    agentName,
    provider: agentName === 'claude' ? 'claude-code' : 'codex',
    workingPath,
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

    test('file attachment post: reference registered, wall stores marker-free preview, web reads the file', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      // realpath: attachment refs are canonicalized, and registration confines paths to the
      // runtime's working directory — the session's workingPath must be the (real) test dir.
      const dir = await realpath(await mkdtemp(join(tmpdir(), 'monad-attachment-')));
      createManagedNativeSession(handlers, sessionId, 'ncli_test', 'codex', 'running', dir);
      try {
        const longBody = `START ${'x'.repeat(150_000)} END`;
        const filePath = join(dir, 'report.md');
        const extraPath = join(dir, 'notes.txt');
        await writeFile(filePath, longBody, 'utf8');
        await writeFile(extraPath, 'side notes', 'utf8');

        const posted = await t.fetch(
          '/v1/internal/native-agent/project/post',
          json(
            { projectId: sessionId, attachments: [{ path: filePath }, { path: extraPath }] },
            bindingHeaders(sessionId)
          )
        );
        expect(posted.status).toBe(200);
        const postedBody = (await posted.json()) as {
          message: { text: string; attachments?: Array<{ id: string; path: string; name: string; bytes: number }> };
        };
        const attachments = postedBody.message.attachments ?? [];
        expect(attachments).toHaveLength(2);
        const attachment = attachments[0];
        if (!attachment) throw new Error('expected attachment ref on posted message');
        expect(attachment.id.startsWith('att_')).toBe(true);
        expect(attachment.path).toBe(filePath);
        expect(attachment.name).toBe('report.md');
        expect(attachment.bytes).toBe(Buffer.byteLength(longBody, 'utf8'));
        expect(attachments[1]?.name).toBe('notes.txt');

        // Wall stores only the bounded, marker-free preview; the structured refs live in message
        // data (rendered as chips) and reference markers appear only in stdin notices.
        const wall = await messages(t, sessionId);
        expect(wall).toHaveLength(1);
        const wallText = wall[0]?.text ?? '';
        expect(wallText.startsWith('START ')).toBe(true);
        expect(wallText).not.toContain('[Attachment');
        expect(wallText.length).toBeLessThan(3_000);

        // Client-facing read (web wall): bounded JSON preview and raw download from the file.
        const webRes = await t.fetch(`/v1/attachments/${attachment.id}`);
        expect(webRes.status).toBe(200);
        const webBody = (await webRes.json()) as { text: string; truncated?: boolean };
        expect(webBody.text.startsWith('START ')).toBe(true);
        const download = await t.fetch(`/v1/attachments/${attachment.id}?download=1`);
        expect(download.status).toBe(200);
        expect(download.headers.get('content-disposition')).toContain('report.md');
        expect(await download.text()).toBe(longBody);

        // Reference semantics: deleting the file makes later reads report the reference as gone.
        await rm(filePath);
        expect((await t.fetch(`/v1/attachments/${attachment.id}`)).status).toBe(410);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('non-Latin-1 attachment names download with an RFC 5987 content-disposition', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      const dir = await realpath(await mkdtemp(join(tmpdir(), 'monad-attachment-')));
      createManagedNativeSession(handlers, sessionId, 'ncli_test', 'codex', 'running', dir);
      try {
        const filePath = join(dir, '项目报告.md');
        await writeFile(filePath, '# 报告', 'utf8');
        const posted = await t.fetch(
          '/v1/internal/native-agent/project/post',
          json({ attachments: [{ path: filePath }] }, bindingHeaders(sessionId))
        );
        expect(posted.status).toBe(200);
        const { message } = (await posted.json()) as { message: { attachments?: Array<{ id: string }> } };
        const id = message.attachments?.[0]?.id;
        if (!id) throw new Error('expected attachment ref');
        const download = await t.fetch(`/v1/attachments/${id}?download=1`);
        expect(download.status).toBe(200);
        expect(download.headers.get('content-disposition')).toContain("filename*=UTF-8''");
        expect(await download.text()).toBe('# 报告');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('attachment endpoint serves only registered references; bad paths are rejected at post', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      const dir = await realpath(await mkdtemp(join(tmpdir(), 'monad-attachment-')));
      const outsideDir = await realpath(await mkdtemp(join(tmpdir(), 'monad-outside-')));
      createManagedNativeSession(handlers, sessionId, 'ncli_test', 'codex', 'running', dir);
      try {
        // The web endpoint is id-gated: unregistered ids never resolve to file reads.
        expect((await t.fetch('/v1/attachments/att_UNKNOWN')).status).toBe(404);

        // Referencing a nonexistent file fails the post outright; nothing lands on the wall.
        const missing = await t.fetch(
          '/v1/internal/native-agent/project/post',
          json({ attachments: [{ path: join(dir, 'nope.md') }] }, bindingHeaders(sessionId))
        );
        expect(missing.status).toBe(400);

        // Containment: a file outside the runtime's working directory is refused — the daemon
        // must not read (or expose) paths the agent could not reach itself.
        const secretPath = join(outsideDir, 'secret.txt');
        await writeFile(secretPath, 'not yours', 'utf8');
        const outside = await t.fetch(
          '/v1/internal/native-agent/project/post',
          json({ attachments: [{ path: secretPath }] }, bindingHeaders(sessionId))
        );
        expect(outside.status).toBe(403);
        expect((await responseError(outside)).code).toBe('ATTACHMENT_PATH_OUTSIDE_WORKSPACE');

        expect(await messages(t, sessionId)).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
        await rm(outsideDir, { recursive: true, force: true });
      }
    });

    test('agent send with a file attachment keeps the direct ledger bounded to preview + reference', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      const dir = await realpath(await mkdtemp(join(tmpdir(), 'monad-attachment-')));
      createManagedNativeSession(handlers, sessionId, 'ncli_test', 'codex', 'running', dir);
      try {
        const longBody = `PRIVATE ${'y'.repeat(140_000)}`;
        const filePath = join(dir, 'private-note.txt');
        await writeFile(filePath, longBody, 'utf8');

        const sent = await t.fetch(
          '/v1/internal/native-agent/agent/send',
          json({ to: 'human:zeke', attachments: [{ path: filePath }] }, bindingHeaders(sessionId))
        );
        expect(sent.status).toBe(200);

        const read = await t.fetch(
          '/v1/internal/native-agent/agent/read',
          json({ with: 'human:zeke' }, bindingHeaders(sessionId))
        );
        const { messages: direct } = (await read.json()) as {
          messages: Array<{ text: string; attachments?: Array<{ id: string; path: string }> }>;
        };
        expect(direct).toHaveLength(1);
        expect(direct[0]?.attachments?.[0]?.path).toBe(filePath);
        expect(direct[0]?.text.startsWith('PRIVATE ')).toBe(true);
        expect(direct[0]?.text).not.toContain('[Attachment');
        expect(direct[0]?.text.length ?? 0).toBeLessThan(3_000);
        expect(await messages(t, sessionId)).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('project ask renders a structured question and returns the user answer to the managed runtime', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      const current = handlers.store.getWorkplaceProject(sessionId);
      if (!current) throw new Error('expected workplace project');
      if (!current.origin) throw new Error('expected workplace project origin');
      handlers.store.updateWorkplaceProject(sessionId, {
        origin: {
          ...current.origin,
          ext: {
            ...(current.origin.ext ?? {}),
            [workplaceProjectMembersExtKey]: [
              {
                type: 'native-cli',
                name: 'codex',
                instanceId: 'codex',
                displayName: 'Lily',
                settings: { managedProjectAgent: true }
              },
              {
                type: 'native-cli',
                name: 'claude',
                instanceId: 'claude',
                displayName: 'Steve',
                settings: { managedProjectAgent: true }
              }
            ]
          }
        }
      });
      createManagedNativeSession(handlers, sessionId);
      createManagedNativeSession(handlers, sessionId, 'ncli_peer', 'claude');
      const requested = t.sse(`/v1/projects/${sessionId}/events`, {
        until: (event) => event.type === 'clarify.requested',
        timeoutMs: 3000
      });

      const ask = t.fetch(
        '/v1/internal/native-agent/project/ask',
        json(
          {
            question: 'Which path should I take?',
            options: ['Ship', 'Revise'],
            mode: 'multiple',
            allowOther: true
          },
          bindingHeaders(sessionId)
        )
      );

      const requestEvent = ((await requested) as Event[]).find((event) => event.type === 'clarify.requested');
      expect(requestEvent?.payload).toMatchObject({
        question: 'Which path should I take?',
        options: ['Ship', 'Revise'],
        mode: 'multiple',
        allowOther: true,
        asker: { id: 'codex', name: 'Lily' }
      });
      const requestId = requestEvent?.payload.requestId as string;
      const answer = await t.fetch('/v1/clarifications/respond', json({ requestId, answer: '["Ship"]' }));
      expect(answer.status).toBe(200);

      const res = await ask;
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, requestId, answer: '["Ship"]' });
      const wall = await messages(t, sessionId);
      expect(wall).toHaveLength(2);
      expect(wall[0]).toEqual({
        role: 'assistant',
        text: 'Q: Which path should I take?\nOptions: Ship | Revise\nA: Ship'
      });
      const summaryText = wall[1]?.text;
      if (!summaryText) throw new Error('expected project Q&A summary text');
      expect(wall[1]?.role).toBe('system');
      expect(summaryText).toContain('Project Q&A summary:');
      expect(summaryText).toContain('Asked by: Lily');
      expect(summaryText).toContain('Question: Which path should I take?');
      expect(summaryText).toContain('User answer: Ship');

      const peerInbox = await t.fetch(
        '/v1/internal/native-agent/project/inbox',
        json({ projectId: sessionId }, bindingHeaders(sessionId, 'ncli_peer', 'claude'))
      );
      expect(peerInbox.status).toBe(200);
      expect(
        ((await peerInbox.json()) as { items: Array<{ message: { role: string; text: string } }> }).items.map(
          (item) => ({ role: item.message.role, text: item.message.text })
        )
      ).toEqual([{ role: 'system', text: summaryText }]);
    });

    test('multiple managed replies reach the wall in post order and hydrate identically for a late viewer', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId, 'ncli_codex', 'codex');
      createManagedNativeSession(handlers, sessionId, 'ncli_claude', 'claude');

      // Two agents post to the wall in sequence.
      const first = await t.fetch(
        '/v1/internal/native-agent/project/post',
        json({ projectId: sessionId, text: 'codex: looks good' }, bindingHeaders(sessionId, 'ncli_codex', 'codex'))
      );
      expect(first.status).toBe(200);
      const second = await t.fetch(
        '/v1/internal/native-agent/project/post',
        json({ projectId: sessionId, text: 'claude: I agree' }, bindingHeaders(sessionId, 'ncli_claude', 'claude'))
      );
      expect(second.status).toBe(200);

      // Raw transcript: both on the wall, in the order they were posted, with exact content.
      expect(await messages(t, sessionId)).toEqual([
        { role: 'assistant', text: 'codex: looks good' },
        { role: 'assistant', text: 'claude: I agree' }
      ]);

      // A viewer opening the project afterwards sees the same order + content in the projected UI.
      const events = await t.sse(`/v1/projects/${sessionId}/ui-stream`, {
        until: (e) => (e as unknown as SessionUiEvent).kind === 'snapshot',
        timeoutMs: 3000
      });
      const snap = (events as unknown as SessionUiEvent[]).find((e) => e.kind === 'snapshot');
      if (snap?.kind !== 'snapshot') throw new Error('expected ui-stream snapshot');
      const wall = snap.items
        .filter((i) => i.kind === 'message')
        .map((i) => (i.kind === 'message' ? i.parts.find((p) => p.type === 'text') : undefined))
        .map((p) => (p?.type === 'text' ? p.text : undefined));
      expect(wall).toEqual(['codex: looks good', 'claude: I agree']);
    });

    test('replies posted out of fan-out order hydrate in post order rather than thinking-start order', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId, 'ncli_codex', 'codex');
      createManagedNativeSession(handlers, sessionId, 'ncli_claude', 'claude');

      // A human message fans out to both agents; each reserves a "thinking" placeholder at fan-out
      // time — codex a hair before claude (loop order), stamped in the far past to stand apart from
      // the (real-clock) completion time below.
      handlers.store.insertMessage('msg_USER', sessionId, 'plan the split', '2020-01-01T00:00:01.000Z', 'user');
      handlers.store.insertMessage('msg_CODEX', sessionId, '', '2020-01-01T00:00:02.000Z', 'assistant', {
        data: {
          agentName: 'codex',
          nativeCliSessionId: 'ncli_codex',
          reasoning: 'Thinking',
          source: 'managed-native-cli'
        },
        includeInContext: false,
        streamStatus: 'streaming'
      });
      handlers.store.insertMessage('msg_CLAUDE', sessionId, '', '2020-01-01T00:00:03.000Z', 'assistant', {
        data: {
          agentName: 'claude',
          nativeCliSessionId: 'ncli_claude',
          reasoning: 'Thinking',
          source: 'managed-native-cli'
        },
        includeInContext: false,
        streamStatus: 'streaming'
      });

      // claude posts FIRST, codex SECOND — the reverse of the fan-out (placeholder) order.
      const claudePost = await t.fetch(
        '/v1/internal/native-agent/project/post',
        json(
          { projectId: sessionId, text: 'claude: here is the split' },
          bindingHeaders(sessionId, 'ncli_claude', 'claude')
        )
      );
      expect(claudePost.status).toBe(200);
      const codexPost = await t.fetch(
        '/v1/internal/native-agent/project/post',
        json(
          { projectId: sessionId, text: 'codex: that split matches mine' },
          bindingHeaders(sessionId, 'ncli_codex', 'codex')
        )
      );
      expect(codexPost.status).toBe(200);

      // A late viewer's hydrated wall orders by post time (the projection's seq), so claude's reply
      // precedes the codex reply that answers it — even though codex's placeholder was reserved first.
      const events = await t.sse(`/v1/projects/${sessionId}/ui-stream`, {
        until: (e) => (e as unknown as SessionUiEvent).kind === 'snapshot',
        timeoutMs: 3000
      });
      const snap = (events as unknown as SessionUiEvent[]).find((e) => e.kind === 'snapshot');
      if (snap?.kind !== 'snapshot') throw new Error('expected ui-stream snapshot');
      const wall = snap.items
        .filter((i) => i.kind === 'message')
        .slice()
        .sort((a, b) => (a.kind === 'message' && b.kind === 'message' ? a.seq.localeCompare(b.seq) : 0))
        .map((i) => (i.kind === 'message' ? i.parts.find((p) => p.type === 'text') : undefined))
        .map((p) => (p?.type === 'text' ? p.text : undefined));
      expect(wall).toEqual(['plan the split', 'claude: here is the split', 'codex: that split matches mine']);
    });

    test('project post is streamed live even without a pending wake placeholder', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId);
      const eventP = t.sse(`/v1/projects/${sessionId}/events`, {
        until: (event) =>
          event.type === 'agent.message' &&
          (event.payload as { agentName?: unknown; text?: unknown }).agentName === 'codex' &&
          (event.payload as { text?: unknown }).text === 'live managed reply',
        timeoutMs: 3000
      });
      const uiP = t.sse(`/v1/projects/${sessionId}/ui-stream`, {
        until: (event) => {
          const uiEvent = event as unknown as SessionUiEvent;
          return (
            uiEvent.kind === 'upsert' &&
            uiEvent.item.kind === 'message' &&
            uiEvent.item.role === 'assistant' &&
            uiEvent.item.agentName === 'codex' &&
            uiEvent.item.parts.some((part) => part.type === 'text' && part.text === 'live managed reply')
          );
        },
        timeoutMs: 3000
      });

      const res = await t.fetch(
        '/v1/internal/native-agent/project/post',
        json({ projectId: sessionId, text: 'live managed reply' }, bindingHeaders(sessionId))
      );

      expect(res.status).toBe(200);
      expect((await eventP).some((event) => event.type === 'agent.message')).toBe(true);
      expect((await uiP).some((event) => (event as unknown as SessionUiEvent).kind === 'upsert')).toBe(true);
      expect(await messages(t, sessionId)).toEqual([{ role: 'assistant', text: 'live managed reply' }]);
    });

    test('duplicate project posts from the same runtime land as separate messages', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId);

      const first = await t.fetch(
        '/v1/internal/native-agent/project/post',
        json({ projectId: sessionId, text: 'KTzhou joined. Ready for tasks.' }, bindingHeaders(sessionId))
      );
      const second = await t.fetch(
        '/v1/internal/native-agent/project/post',
        json({ projectId: sessionId, text: 'KTzhou joined. Ready for tasks.' }, bindingHeaders(sessionId))
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await messages(t, sessionId)).toEqual([
        { role: 'assistant', text: 'KTzhou joined. Ready for tasks.' },
        { role: 'assistant', text: 'KTzhou joined. Ready for tasks.' }
      ]);
    });

    test('provider completion without a project post clears the managed native CLI thinking placeholder', async () => {
      const handlers = buildHandlers(mockModel());
      t = serveTransport(kind, createHttpTransport(handlers));
      const sessionId = await createSession(t);
      createManagedNativeSession(handlers, sessionId);
      handlers.store.insertMessage('msg_USER', sessionId, 'hi', '2026-06-30T00:00:01.000Z', 'user');
      handlers.store.insertMessage('msg_THINKING', sessionId, '', '2026-06-30T00:00:02.000Z', 'assistant', {
        data: {
          agentName: 'codex',
          nativeCliSessionId: 'ncli_test',
          reasoning: 'Thinking',
          source: 'managed-native-cli'
        },
        includeInContext: false,
        streamStatus: 'streaming'
      });
      handlers.store.enqueueNativeCliInboxItem('ncli_test', handlers.store.maxMessageSeq(sessionId));
      handlers.store.markNativeCliInboxDelivered('ncli_test', handlers.store.maxMessageSeq(sessionId));
      handlers.store.markNativeCliInboxConsumed('ncli_test', handlers.store.maxMessageSeq(sessionId));

      await handlers.session.completeManagedNativeCliProviderMessage({
        sessionId,
        nativeCliSessionId: 'ncli_test',
        agentName: 'codex',
        text: 'No action needed.',
        post: false
      });

      expect(await messages(t, sessionId)).toEqual([{ role: 'user', text: 'hi' }]);
      expect(handlers.store.findManagedNativeCliStreamingMessage(sessionId, 'ncli_test', 'codex')).toBeNull();
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
      handlers.store.enqueueNativeCliInboxItem('ncli_test', 3);

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
      handlers.store.enqueueNativeCliInboxItem('ncli_inbox', 1);

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
      handlers.store.enqueueNativeCliInboxItem('ncli_ack', 1);

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
      handlers.store.enqueueNativeCliInboxItem('ncli_runtime_info', 1);
      handlers.store.enqueueNativeCliInboxItem('ncli_runtime_info', 2);
      handlers.store.markNativeCliInboxDelivered('ncli_runtime_info', handlers.store.maxMessageSeq(sessionId));

      const res = await t.fetch('/v1/internal/native-agent/runtime/info', {
        headers: bindingHeaders(sessionId, 'ncli_runtime_info')
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        agentId: 'codex',
        projectId: sessionId,
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
