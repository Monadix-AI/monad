import type { ChatMessage, MessageId, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { makeEvent } from '#/services/event-bus.ts';
import { createSessionMessageGenerationSseResponse } from '#/transports/http/sessions/stream.ts';
import { createConnectionState } from '#/transports/jsonrpc/connection.ts';
import { RPC_HANDLERS } from '#/transports/jsonrpc/methods.ts';
import { buildMockModel } from '../fixtures/mock-model.ts';
import { buildHandlers } from '../helpers.ts';

const producer = { kind: 'system', subsystem: 'message-generation-test' } as const;

function pendingMessage(sessionId: SessionId, messageId: MessageId): ChatMessage {
  return {
    id: messageId,
    sessionId,
    role: 'assistant',
    text: '',
    type: 'markdown',
    stream: { status: 'pending', source: { transcriptTargetId: sessionId, messageId } },
    active: true,
    createdAt: '2026-07-19T00:00:00.000Z'
  };
}

test('message generation subscription sends an authoritative snapshot then only scoped ordered events', async () => {
  const handlers = buildHandlers(buildMockModel().text(['unused']).build());
  const { sessionId } = await handlers.session.create({ title: 'stream' });
  const messageId = newId('msg');
  const otherMessageId = newId('msg');
  const message = pendingMessage(sessionId, messageId);
  handlers.store.createMessage({ message, idempotencyKey: newId('idem'), fingerprint: 'test:stream' });

  const frames: unknown[] = [];
  const subscription = await handlers.session.subscribeMessageGeneration({ sessionId, messageId }, (frame: unknown) =>
    frames.push(frame)
  );
  const ignored = makeEvent(sessionId, 'session.message.delta.appended', {
    transcriptTargetId: sessionId,
    producer,
    messageId: otherMessageId,
    channel: 'answer',
    index: 0,
    delta: 'ignored'
  });
  const first = makeEvent(sessionId, 'session.message.delta.appended', {
    transcriptTargetId: sessionId,
    producer,
    messageId,
    channel: 'answer',
    index: 0,
    delta: 'hel'
  });
  const second = makeEvent(sessionId, 'session.message.delta.appended', {
    transcriptTargetId: sessionId,
    producer,
    messageId,
    channel: 'answer',
    index: 1,
    delta: 'lo'
  });
  handlers.bus.publish(ignored);
  handlers.bus.publish(first);
  handlers.bus.publish(second);

  expect(frames).toEqual([
    { kind: 'snapshot', message, messageRevision: 1, deltas: [] },
    { kind: 'event', event: first },
    { kind: 'event', event: second }
  ]);
  subscription.dispose();
  handlers.store.close();
});

test('resume replays after a retained cursor and falls back to snapshot for an unavailable cursor', async () => {
  const handlers = buildHandlers(buildMockModel().text(['unused']).build());
  const { sessionId } = await handlers.session.create({ title: 'resume' });
  const messageId = newId('msg');
  const message = pendingMessage(sessionId, messageId);
  handlers.store.createMessage({ message, idempotencyKey: newId('idem'), fingerprint: 'test:resume' });
  const first = makeEvent(sessionId, 'session.message.delta.appended', {
    transcriptTargetId: sessionId,
    producer,
    messageId,
    channel: 'answer',
    index: 0,
    delta: 'a'
  });
  const second = makeEvent(sessionId, 'session.message.delta.appended', {
    transcriptTargetId: sessionId,
    producer,
    messageId,
    channel: 'answer',
    index: 1,
    delta: 'b'
  });
  handlers.bus.publish(first);
  handlers.bus.publish(second);

  const resumed: unknown[] = [];
  const live = await handlers.session.subscribeMessageGeneration(
    { sessionId, messageId, afterEventId: first.id },
    (frame: unknown) => resumed.push(frame)
  );
  expect(resumed).toEqual([{ kind: 'event', event: second }]);
  live.dispose();

  const repaired: unknown[] = [];
  const fallback = await handlers.session.subscribeMessageGeneration(
    { sessionId, messageId, afterEventId: newId('evt') },
    (frame: unknown) => repaired.push(frame)
  );
  expect(repaired).toEqual([{ kind: 'snapshot', message, messageRevision: 1, deltas: [first, second] }]);
  fallback.dispose();
  handlers.store.close();
});

test('terminal event is forwarded unchanged and disposes the live listener', async () => {
  const handlers = buildHandlers(buildMockModel().text(['unused']).build());
  const { sessionId } = await handlers.session.create({ title: 'terminal' });
  const messageId = newId('msg');
  const pending = pendingMessage(sessionId, messageId);
  handlers.store.createMessage({ message: pending, idempotencyKey: newId('idem'), fingerprint: 'test:terminal' });

  const frames: unknown[] = [];
  const { dispose } = await handlers.session.subscribeMessageGeneration({ sessionId, messageId }, (frame: unknown) =>
    frames.push(frame)
  );
  const completedMessage: ChatMessage = {
    ...pending,
    text: 'done',
    stream: { status: 'complete' },
    updatedAt: '2026-07-19T00:00:01.000Z'
  };
  const terminal = makeEvent(sessionId, 'session.message.completed', {
    transcriptTargetId: sessionId,
    producer,
    message: completedMessage,
    messageRevision: 2
  });
  handlers.bus.publish(terminal);
  const late = makeEvent(sessionId, 'session.message.delta.appended', {
    transcriptTargetId: sessionId,
    producer,
    messageId,
    channel: 'answer',
    index: 2,
    delta: 'late'
  });
  handlers.bus.publish(late);

  expect(frames).toEqual([
    { kind: 'snapshot', message: pending, messageRevision: 1, deltas: [] },
    { kind: 'event', event: terminal }
  ]);
  dispose();
  handlers.store.close();
});

test('a throwing slow sink is disposed before later generation events', async () => {
  const handlers = buildHandlers(buildMockModel().text(['unused']).build());
  const { sessionId } = await handlers.session.create({ title: 'slow' });
  const messageId = newId('msg');
  const message = pendingMessage(sessionId, messageId);
  handlers.store.createMessage({ message, idempotencyKey: newId('idem'), fingerprint: 'test:slow' });
  let calls = 0;
  await handlers.session.subscribeMessageGeneration({ sessionId, messageId }, () => {
    calls++;
    if (calls === 2) throw new Error('consumer stalled');
  });
  for (const [index, delta] of ['first', 'ignored'].entries()) {
    handlers.bus.publish(
      makeEvent(sessionId, 'session.message.delta.appended', {
        transcriptTargetId: sessionId,
        producer,
        messageId,
        channel: 'answer',
        index,
        delta
      })
    );
  }
  expect(calls).toBe(2);
  handlers.store.close();
});

test('message ownership and session scope are enforced before subscribing', async () => {
  const handlers = buildHandlers(buildMockModel().text(['unused']).build());
  const { sessionId } = await handlers.session.create({ title: 'owner' });
  const { sessionId: otherSessionId } = await handlers.session.create({ title: 'other' });
  const messageId = newId('msg');
  handlers.store.createMessage({
    message: pendingMessage(sessionId, messageId),
    idempotencyKey: newId('idem'),
    fingerprint: 'test:owner'
  });

  await expect(
    handlers.session.subscribeMessageGeneration({ sessionId: otherSessionId, messageId }, () => {})
  ).rejects.toThrow(`message not found: ${messageId}`);
  await expect(
    handlers.session.subscribeMessageGeneration({ sessionId: newId('ses'), messageId }, () => {})
  ).rejects.toThrow('session not found');
  handlers.store.close();
});

test('JSON-RPC subscription returns the snapshot and pushes scoped live frames until unsubscribe', async () => {
  const handlers = buildHandlers(buildMockModel().text(['unused']).build());
  const { sessionId } = await handlers.session.create({ title: 'rpc' });
  const messageId = newId('msg');
  const message = pendingMessage(sessionId, messageId);
  handlers.store.createMessage({ message, idempotencyKey: newId('idem'), fingerprint: 'test:rpc' });
  const pushed: unknown[] = [];
  const state = createConnectionState();
  const ack = await RPC_HANDLERS['session.messageGeneration.subscribe']({ id: sessionId, messageId }, handlers, {
    state,
    push: (notification) => pushed.push(notification)
  });
  const delta = makeEvent(sessionId, 'session.message.delta.appended', {
    transcriptTargetId: sessionId,
    producer,
    messageId,
    channel: 'answer',
    index: 0,
    delta: 'rpc'
  });
  handlers.bus.publish(delta);
  const terminal = makeEvent(sessionId, 'session.message.completed', {
    transcriptTargetId: sessionId,
    producer,
    message: { ...message, text: 'rpc', stream: { status: 'complete' } },
    messageRevision: 2
  });
  handlers.bus.publish(terminal);

  expect(ack).toEqual({
    subscribed: true,
    initial: [{ kind: 'snapshot', message, messageRevision: 1, deltas: [] }]
  });
  expect(pushed).toEqual([
    {
      jsonrpc: '2.0',
      method: 'session.messageGeneration.event',
      params: { sessionId, messageId, frame: { kind: 'event', event: delta } }
    },
    {
      jsonrpc: '2.0',
      method: 'session.messageGeneration.event',
      params: { sessionId, messageId, frame: { kind: 'event', event: terminal } }
    }
  ]);
  expect(state.messageGenerations?.has(`message:${sessionId}:${messageId}`)).toBe(false);

  await RPC_HANDLERS['session.messageGeneration.unsubscribe']({ id: sessionId, messageId }, handlers, {
    state,
    push: (notification) => pushed.push(notification)
  });
  handlers.bus.publish(
    makeEvent(sessionId, 'session.message.delta.appended', {
      transcriptTargetId: sessionId,
      producer,
      messageId,
      channel: 'answer',
      index: 1,
      delta: 'ignored'
    })
  );
  expect(pushed).toHaveLength(2);
  handlers.store.close();
});

test('HTTP message stream frames snapshot and terminal with canonical SSE ids then closes', async () => {
  const handlers = buildHandlers(buildMockModel().text(['unused']).build());
  const { sessionId } = await handlers.session.create({ title: 'sse' });
  const messageId = newId('msg');
  const message = pendingMessage(sessionId, messageId);
  handlers.store.createMessage({ message, idempotencyKey: newId('idem'), fingerprint: 'test:sse' });
  const response = await createSessionMessageGenerationSseResponse({
    handlers,
    sessionId,
    messageId,
    encoder: new TextEncoder()
  });
  const terminal = makeEvent(sessionId, 'session.message.failed', {
    transcriptTargetId: sessionId,
    producer,
    message: { ...message, text: 'failed', stream: { status: 'error' } },
    messageRevision: 2
  });
  handlers.bus.publish(terminal);
  const body = await response.text();

  expect(response.headers.get('content-type')).toBe('text/event-stream');
  expect(body).toBe(
    `event: session.message.snapshot\ndata: ${JSON.stringify({
      kind: 'snapshot',
      message,
      messageRevision: 1,
      deltas: []
    })}\n\nid: ${terminal.id}\nevent: session.message.failed\ndata: ${JSON.stringify({
      kind: 'event',
      event: terminal
    })}\n\n`
  );
  handlers.store.close();
});

test('HTTP message stream closes after an authoritative terminal snapshot', async () => {
  const handlers = buildHandlers(buildMockModel().text(['unused']).build());
  const { sessionId } = await handlers.session.create({ title: 'settled snapshot' });
  const messageId = newId('msg');
  const message: ChatMessage = {
    ...pendingMessage(sessionId, messageId),
    text: 'already done',
    stream: { status: 'complete' }
  };
  handlers.store.createMessage({ message, idempotencyKey: newId('idem'), fingerprint: 'test:settled-snapshot' });
  const response = await createSessionMessageGenerationSseResponse({
    handlers,
    sessionId,
    messageId,
    encoder: new TextEncoder()
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error('expected SSE response body');
  const first = await reader.read();
  const second = await Promise.race([
    reader.read(),
    new Promise<{ done: false; value: undefined }>((resolve) =>
      setTimeout(() => resolve({ done: false, value: undefined }), 50)
    )
  ]);
  await reader.cancel();

  expect({ first: new TextDecoder().decode(first.value), secondDone: second.done }).toEqual({
    first: `event: session.message.snapshot\ndata: ${JSON.stringify({
      kind: 'snapshot',
      message,
      messageRevision: 1,
      deltas: []
    })}\n\n`,
    secondDone: true
  });
  handlers.store.close();
});

test('HTTP resume cursor emits only later retained events with their canonical SSE ids', async () => {
  const handlers = buildHandlers(buildMockModel().text(['unused']).build());
  const { sessionId } = await handlers.session.create({ title: 'sse resume' });
  const messageId = newId('msg');
  const message = pendingMessage(sessionId, messageId);
  handlers.store.createMessage({ message, idempotencyKey: newId('idem'), fingerprint: 'test:sse-resume' });
  const first = makeEvent(sessionId, 'session.message.delta.appended', {
    transcriptTargetId: sessionId,
    producer,
    messageId,
    channel: 'answer',
    index: 0,
    delta: 'first'
  });
  const second = makeEvent(sessionId, 'session.message.delta.appended', {
    transcriptTargetId: sessionId,
    producer,
    messageId,
    channel: 'answer',
    index: 1,
    delta: 'second'
  });
  const terminal = makeEvent(sessionId, 'session.message.completed', {
    transcriptTargetId: sessionId,
    producer,
    message: { ...message, text: 'firstsecond', stream: { status: 'complete' } },
    messageRevision: 2
  });
  handlers.bus.publish(first);
  handlers.bus.publish(second);
  handlers.bus.publish(terminal);
  const response = await createSessionMessageGenerationSseResponse({
    handlers,
    sessionId,
    messageId,
    afterEventId: first.id,
    encoder: new TextEncoder()
  });

  expect(await response.text()).toBe(
    `id: ${second.id}\nevent: session.message.delta.appended\ndata: ${JSON.stringify({
      kind: 'event',
      event: second
    })}\n\nid: ${terminal.id}\nevent: session.message.completed\ndata: ${JSON.stringify({
      kind: 'event',
      event: terminal
    })}\n\n`
  );
  handlers.store.close();
});
