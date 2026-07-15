import type { Event, SessionId, SessionUiEvent } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { RoundCache } from '#/services/round-cache.ts';
import { buildMockModel } from '../../fixtures/mock-model.ts';
import { buildHandlers } from '../../helpers.ts';

function evt(sessionId: SessionId, type: Event['type'], payload: Record<string, unknown>): Event {
  return { id: newId('evt'), sessionId, type, actorAgentId: null, payload, at: new Date().toISOString() };
}

async function collect(
  handlers: ReturnType<typeof buildHandlers>,
  transcriptTargetId: SessionId,
  afterEventId?: string
): Promise<Event[]> {
  const received: Event[] = [];
  const { dispose } = await handlers.session.subscribe({ sessionId: transcriptTargetId, afterEventId }, (e) =>
    received.push(e)
  );
  dispose();
  return received;
}

test('reconnect from a persisted cursor merges missed durable rounds with the in-flight round', async () => {
  const cache = new RoundCache();
  const handlers = buildHandlers(buildMockModel().text(['x']).build(), undefined, { cache });
  const sessionId = newId('ses') as SessionId;

  // Round 1 is fully persisted (agent.token/reasoning are never persisted, so it settles as messages).
  const r1User = evt(sessionId, 'user.message', { messageId: newId('msg'), text: 'hi' });
  const r1Msg = evt(sessionId, 'agent.message', { messageId: newId('msg'), text: 'one' });
  handlers.store.appendEvents([r1User, r1Msg]);

  // Round 2 is in flight — only the RoundCache holds it (un-persisted).
  const r2User = evt(sessionId, 'user.message', { messageId: newId('msg'), text: 'again' });
  const r2Tok1 = evt(sessionId, 'agent.token', { messageId: newId('msg'), delta: 'tw', index: 0 });
  const r2Tok2 = evt(sessionId, 'agent.token', { messageId: r2Tok1.payload.messageId, delta: 'o', index: 1 });
  for (const e of [r2User, r2Tok1, r2Tok2]) cache.append(e);

  // Client last saw r1User (persisted). It must receive the rest of round 1 AND all of round 2.
  const received = await collect(handlers, sessionId, r1User.id);
  expect(received.map((e) => e.id)).toEqual([r1Msg.id, r2User.id, r2Tok1.id, r2Tok2.id]);

  handlers.store.close();
});

test('reconnect from an un-persisted live cursor resumes the active round without a full replay', async () => {
  const cache = new RoundCache();
  const handlers = buildHandlers(buildMockModel().text(['x']).build(), undefined, { cache });
  const sessionId = newId('ses') as SessionId;

  handlers.store.appendEvents([evt(sessionId, 'agent.message', { messageId: newId('msg'), text: 'old round' })]);

  const tok1 = evt(sessionId, 'agent.token', { messageId: newId('msg'), delta: 'a', index: 0 });
  const tok2 = evt(sessionId, 'agent.token', { messageId: tok1.payload.messageId, delta: 'b', index: 1 });
  for (const e of [tok1, tok2]) cache.append(e);

  // tok1 is an un-persisted token id. listEvents(tok1) would fall back to the whole session; the fix
  // must gate that off and resume from the in-process buffer instead.
  const received = await collect(handlers, sessionId, tok1.id);
  expect(received.map((e) => e.id)).toEqual([tok2.id]);

  handlers.store.close();
});

test('idle reconnect (no active round) replays durable events after the cursor', async () => {
  const handlers = buildHandlers(buildMockModel().text(['x']).build());
  const sessionId = newId('ses') as SessionId;

  const a = evt(sessionId, 'agent.message', { messageId: newId('msg'), text: 'one' });
  const b = evt(sessionId, 'agent.message', { messageId: newId('msg'), text: 'two' });
  handlers.store.appendEvents([a, b]);

  const received = await collect(handlers, sessionId, a.id);
  expect(received.map((e) => e.id)).toEqual([b.id]);

  handlers.store.close();
});

test('subscribeUi reconnect with an un-persisted cursor does not full-replay the durable log', async () => {
  const handlers = buildHandlers(buildMockModel().text(['x']).build());
  const { sessionId } = await handlers.session.create({ title: 't' });
  const now = new Date().toISOString();
  handlers.store.insertMessage(newId('msg'), sessionId, 'hi', now, 'user');
  // A durable tool.called with NO backing message row: hydration (message-based) omits it, but a
  // buggy full-replay of the event log would surface it as a ghost tool card.
  handlers.store.appendEvents([evt(sessionId, 'tool.called', { toolCallId: 'call_ghost', tool: 'shell_exec' })]);

  // Reconnect: no active round buffered, cursor is an un-persisted (agent.token-shaped) event id.
  let snap: SessionUiEvent | undefined;
  const { dispose } = await handlers.session.subscribeUi({ sessionId, afterEventId: newId('evt') }, (e) => {
    if (!snap && e.kind === 'snapshot') snap = e;
  });
  dispose();
  if (snap?.kind !== 'snapshot') throw new Error('expected hydrated snapshot');
  expect(snap.items.some((i) => i.kind === 'tool' && i.id === 'call_ghost')).toBe(false);
  expect(snap.items.some((i) => i.kind === 'message')).toBe(true);

  handlers.store.close();
});

test('subscribeUi keeps managed external agent joins after newer transcript messages', async () => {
  const handlers = buildHandlers(buildMockModel().text(['x']).build());
  const { projectId } = await handlers.session.createProject({
    title: 'project',
    cwd: process.cwd(),
    origin: { surface: 'web', client: 'workplace', transport: 'http', writableBy: ['http'], branchableBy: ['http'] }
  });
  const { sessionId } = await handlers.session.createProjectSession({ projectId, title: 'project session' });
  const project = sessionId;
  const startedAt = '2026-07-02T00:00:00.000Z';
  const messageAt = '2026-07-02T00:01:00.000Z';

  handlers.store.upsertExternalAgentSession({
    id: 'exa_managedsL5l3',
    transcriptTargetId: project,
    agentName: 'pmem_codex_test',
    provider: 'codex',
    workingPath: process.cwd(),
    launchMode: 'app-server',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: 'exa_managedsL5l3',
    agentRuntimeTokenHash: null,
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    state: 'stopped',
    pid: null,
    providerSessionRef: null,
    outputSnapshot: '',
    exitCode: 0,
    startedAt,
    updatedAt: startedAt,
    exitedAt: startedAt
  });
  handlers.store.insertMessage(newId('msg'), project, 'newer user message', messageAt, 'user');

  let snap: SessionUiEvent | undefined;
  const { dispose } = await handlers.session.subscribeUi({ sessionId: project }, (e) => {
    if (!snap && e.kind === 'snapshot') snap = e;
  });
  dispose();

  if (snap?.kind !== 'snapshot') throw new Error('expected hydrated snapshot');
  expect(snap.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'tool',
        id: 'exa_managedsL5l3',
        tool: 'external-agent:codex',
        status: 'ok'
      })
    ])
  );

  handlers.store.close();
});

test('subscribeUi replaces the live snapshot when another client restores the session', async () => {
  const handlers = buildHandlers(buildMockModel().text(['x']).build());
  const { sessionId } = await handlers.session.create({ title: 't' });
  const now = new Date().toISOString();
  const keepUser = newId('msg');
  const keepAssistant = newId('msg');
  const rewindUser = newId('msg');
  handlers.store.insertMessage(keepUser, sessionId, 'keep', now, 'user');
  handlers.store.insertMessage(keepAssistant, sessionId, 'keep response', now, 'assistant');
  handlers.store.insertMessage(rewindUser, sessionId, 'rewind', now, 'user');
  handlers.store.insertMessage(newId('msg'), sessionId, 'remove response', now, 'assistant');

  const snapshots: Extract<SessionUiEvent, { kind: 'snapshot' }>[] = [];
  const { dispose } = await handlers.session.subscribeUi({ sessionId }, (event) => {
    if (event.kind === 'snapshot') snapshots.push(event);
  });

  await handlers.session.restore({ id: sessionId, toMessageId: rewindUser });

  expect(snapshots.map((snapshot) => snapshot.items.map((item) => item.id))).toEqual([
    [keepUser, keepAssistant, rewindUser, expect.any(String)],
    [keepUser, keepAssistant]
  ]);
  expect(snapshots[1]?.replacesTranscript).toBe(true);
  dispose();
  handlers.store.close();
});

test('subscribeUi replaces the live snapshot when another client resets the session', async () => {
  const handlers = buildHandlers(buildMockModel().text(['x']).build());
  const { sessionId } = await handlers.session.create({ title: 't' });
  handlers.store.insertMessage(newId('msg'), sessionId, 'remove', new Date().toISOString(), 'user');

  const snapshots: Extract<SessionUiEvent, { kind: 'snapshot' }>[] = [];
  const { dispose } = await handlers.session.subscribeUi({ sessionId }, (event) => {
    if (event.kind === 'snapshot') snapshots.push(event);
  });

  await handlers.session.reset({ id: sessionId });

  expect(snapshots.map((snapshot) => snapshot.items.map((item) => item.id))).toEqual([[expect.any(String)], []]);
  expect(snapshots[1]?.replacesTranscript).toBe(true);
  dispose();
  handlers.store.close();
});
