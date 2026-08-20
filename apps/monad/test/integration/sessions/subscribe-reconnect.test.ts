import type { Event, SessionId, SessionUiEvent } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { encodeEventCursor } from '#/services/event-cursor.ts';
import { RoundCache } from '#/services/round-cache.ts';
import { buildMockModel } from '../../fixtures/mock-model.ts';
import { buildHandlers } from '../../helpers.ts';

function evt(sessionId: SessionId, type: Event['type'], payload: Record<string, unknown>): Event {
  return { id: newId('evt'), sessionId, type, actorAgentId: null, payload, at: new Date().toISOString() };
}

function userCreated(sessionId: SessionId, text: string, messageId = newId('msg')): Event {
  return evt(sessionId, 'session.message.created', {
    transcriptTargetId: sessionId,
    producer: { kind: 'user' },
    message: {
      id: messageId,
      sessionId,
      role: 'user',
      text,
      type: 'text',
      stream: { status: 'settled' },
      active: true,
      createdAt: '2026-07-19T00:00:00.000Z'
    },
    messageRevision: 1
  });
}

function assistantCompleted(sessionId: SessionId, text: string, messageId = newId('msg')): Event {
  return evt(sessionId, 'session.message.completed', {
    transcriptTargetId: sessionId,
    producer: { kind: 'agent', agentId: 'agt_100000000000' },
    message: {
      id: messageId,
      sessionId,
      role: 'assistant',
      text,
      type: 'text',
      stream: { status: 'complete' },
      active: true,
      createdAt: '2026-07-19T00:00:00.000Z'
    },
    messageRevision: 2
  });
}

function assistantDelta(sessionId: SessionId, messageId: `msg_${string}`, delta: string, index: number): Event {
  return evt(sessionId, 'session.message.delta.appended', {
    transcriptTargetId: sessionId,
    producer: { kind: 'agent', agentId: 'agt_100000000000' },
    messageId,
    channel: 'answer',
    delta,
    index
  });
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

  // Round 1 is fully persisted; transient deltas are absent once it settles as durable messages.
  const r1User = userCreated(sessionId, 'hi');
  const r1Msg = assistantCompleted(sessionId, 'one');
  handlers.store.appendEvents([r1User, r1Msg]);

  // Round 2 is in flight — only the RoundCache holds it (un-persisted).
  const r2User = userCreated(sessionId, 'again');
  const r2MessageId = newId('msg');
  const r2Tok1 = assistantDelta(sessionId, r2MessageId, 'tw', 0);
  const r2Tok2 = assistantDelta(sessionId, r2MessageId, 'o', 1);
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

  handlers.store.appendEvents([assistantCompleted(sessionId, 'old round')]);

  const messageId = newId('msg');
  const tok1 = assistantDelta(sessionId, messageId, 'a', 0);
  const tok2 = assistantDelta(sessionId, messageId, 'b', 1);
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

  const a = assistantCompleted(sessionId, 'one');
  const b = assistantCompleted(sessionId, 'two');
  handlers.store.appendEvents([a, b]);

  const received = await collect(handlers, sessionId, a.id);
  expect(received.map((e) => e.id)).toEqual([b.id]);

  handlers.store.close();
});

test('an encoded scope-bound cursor resolves to its anchor exactly like the bare event id', async () => {
  const handlers = buildHandlers(buildMockModel().text(['x']).build());
  const sessionId = newId('ses') as SessionId;
  const a = assistantCompleted(sessionId, 'one');
  const b = assistantCompleted(sessionId, 'two');
  handlers.store.appendEvents([a, b]);

  const cursor = encodeEventCursor({ plane: 'session.events', transcriptTargetId: sessionId }, a.id);
  const received = await collect(handlers, sessionId, cursor);
  expect(received.map((e) => e.id)).toEqual([b.id]);

  handlers.store.close();
});

test('subscribe rejects a cursor whose durable anchor belongs to another session', async () => {
  const handlers = buildHandlers(buildMockModel().text(['x']).build());
  const sessionA = newId('ses') as SessionId;
  const sessionB = newId('ses') as SessionId;
  const foreign = assistantCompleted(sessionA, 'A round');
  handlers.store.appendEvents([foreign]);
  handlers.store.appendEvents([assistantCompleted(sessionB, 'B round')]);

  await expect(collect(handlers, sessionB, foreign.id)).rejects.toThrow('event cursor has the wrong scope');

  handlers.store.close();
});

test('subscribe rejects an encoded cursor minted for the other replay plane', async () => {
  const handlers = buildHandlers(buildMockModel().text(['x']).build());
  const sessionId = newId('ses') as SessionId;
  const a = assistantCompleted(sessionId, 'one');
  handlers.store.appendEvents([a]);

  const uiCursor = encodeEventCursor({ plane: 'session.ui', transcriptTargetId: sessionId }, a.id);
  await expect(collect(handlers, sessionId, uiCursor)).rejects.toThrow('event cursor has the wrong scope');

  handlers.store.close();
});

test('subscribe rejects an expired encoded cursor whose anchor is gone instead of silently full-replaying', async () => {
  const handlers = buildHandlers(buildMockModel().text(['x']).build());
  const sessionId = newId('ses') as SessionId;
  handlers.store.appendEvents([assistantCompleted(sessionId, 'one')]);

  const expired = encodeEventCursor({ plane: 'session.events', transcriptTargetId: sessionId }, newId('evt'));
  await expect(collect(handlers, sessionId, expired)).rejects.toThrow('event cursor has expired');

  handlers.store.close();
});

test('subscribeUi degrades an expired encoded cursor to a fresh authoritative snapshot instead of rejecting', async () => {
  const handlers = buildHandlers(buildMockModel().text(['x']).build());
  const { sessionId } = await handlers.session.create({ title: 'expired ui cursor' });
  const now = new Date().toISOString();
  handlers.store.insertMessage(newId('msg'), sessionId, 'hi', now, 'user');

  const expired = encodeEventCursor({ plane: 'session.ui', transcriptTargetId: sessionId }, newId('evt'));
  let snap: SessionUiEvent | undefined;
  const { dispose } = await handlers.session.subscribeUi({ sessionId, afterEventId: expired }, (e) => {
    if (!snap && e.kind === 'snapshot') snap = e;
  });
  dispose();

  // Unlike session.events (durable replay truly cannot recover a gone anchor), the ui plane rebuilds a
  // fresh authoritative snapshot from durable history on every connect — an expired anchor is never a
  // real "gone" state here, only a stale resume point.
  if (snap?.kind !== 'snapshot') throw new Error('expected a fresh snapshot, not a rejection');
  expect(snap.items.some((i) => i.kind === 'message')).toBe(true);

  handlers.store.close();
});

test('subscribeUi snapshots include every user-message outline entry beyond the paginated live window', async () => {
  const handlers = buildHandlers(buildMockModel().text(['x']).build());
  const { sessionId } = await handlers.session.create({ title: 'complete outline' });
  const userMessages: Array<{ id: `msg_${string}`; text: string; at: string }> = [];
  for (let index = 0; index < 42; index++) {
    const userId = newId('msg');
    const assistantId = newId('msg');
    const createdAt = new Date(Date.UTC(2026, 6, 19, 0, 0, index)).toISOString();
    const text = `Question ${index + 1}`;
    handlers.store.insertMessage(userId, sessionId, text, createdAt, 'user');
    handlers.store.insertMessage(assistantId, sessionId, `Answer ${index + 1}`, createdAt, 'assistant');
    userMessages.push({ id: userId, text, at: createdAt });
  }

  let snapshot: Extract<SessionUiEvent, { kind: 'snapshot' }> | undefined;
  const { dispose } = await handlers.session.subscribeUi({ sessionId }, (event) => {
    if (event.kind === 'snapshot') snapshot = event;
  });
  dispose();
  if (!snapshot) throw new Error('expected snapshot');

  expect({
    messageOutline: snapshot.messageOutline,
    renderedUserIds: snapshot.items.flatMap((item) =>
      item.kind === 'message' && item.role === 'user' ? [item.id] : []
    )
  }).toEqual({
    messageOutline: userMessages,
    renderedUserIds: userMessages.slice(2).map((item) => item.id)
  });

  handlers.store.close();
});

test('a legacy bare event-id cursor whose anchor is gone degrades to a fresh replay', async () => {
  const handlers = buildHandlers(buildMockModel().text(['x']).build());
  const sessionId = newId('ses') as SessionId;
  const a = assistantCompleted(sessionId, 'one');
  handlers.store.appendEvents([a]);

  // A bare Last-Event-ID from an older client whose anchor is no longer present degrades to a fresh
  // replay (the whole session) rather than a 410 — only the encoded token gets the strict treatment.
  const received = await collect(handlers, sessionId, newId('evt'));
  expect(received.map((e) => e.id)).toEqual([a.id]);

  handlers.store.close();
});

test('subscribe rejects a malformed encoded cursor as invalid', async () => {
  const handlers = buildHandlers(buildMockModel().text(['x']).build());
  const sessionId = newId('ses') as SessionId;
  handlers.store.appendEvents([assistantCompleted(sessionId, 'one')]);

  const malformed = `cur_${Buffer.from('not a cursor payload').toString('base64url')}`;
  await expect(collect(handlers, sessionId, malformed)).rejects.toThrow('event cursor is invalid');

  handlers.store.close();
});

test('subscribeUi reconnect with an un-persisted cursor does not full-replay the durable log', async () => {
  const handlers = buildHandlers(buildMockModel().text(['x']).build());
  const { sessionId } = await handlers.session.create({ title: 't' });
  const now = new Date().toISOString();
  handlers.store.insertMessage(newId('msg'), sessionId, 'hi', now, 'user');
  // A durable tool.called with NO backing message row: hydration (message-based) omits it, but a
  // buggy full-replay of the event log would surface it as a ghost tool card.
  handlers.store.appendEvents([
    evt(sessionId, 'tool.called', { toolCallId: 'call_ghost', tool: 'shell_exec', input: {} })
  ]);

  // Reconnect: no active round buffered, cursor is an un-persisted generation event id.
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

test('subscribeUi restores unresolved questions and approvals into the composer snapshot', async () => {
  const handlers = buildHandlers(buildMockModel().text(['x']).build());
  const { sessionId } = await handlers.session.create({ title: 'pending interactions' });
  handlers.store.appendEvents([
    evt(sessionId, 'clarify.requested', {
      requestId: 'clarify_restore',
      question: 'Which direction?',
      questionMessageId: newId('msg')
    }),
    evt(sessionId, 'tool.approval_requested', {
      requestId: 'approval_restore',
      tool: 'shell_exec',
      input: { command: 'bun test' }
    })
  ]);

  let snap: SessionUiEvent | undefined;
  const { dispose } = await handlers.session.subscribeUi({ sessionId }, (event) => {
    if (!snap && event.kind === 'snapshot') snap = event;
  });
  dispose();

  if (snap?.kind !== 'snapshot') throw new Error('expected hydrated snapshot');
  expect(snap.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'clarification', id: 'clarify_restore', question: 'Which direction?' }),
      expect.objectContaining({ kind: 'approval', id: 'approval_restore', tool: 'shell_exec' })
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
