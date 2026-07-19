import type { Event, Session } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId, parseEventPayload } from '@monad/protocol';

import { EventBus } from '#/services/event-bus.ts';
import { startGenerativeMessage } from '#/services/generation/generative-message.ts';
import { createMessageIngress } from '#/services/messages/ingress.ts';
import { createStore } from '#/store/db/index.ts';

function seedSession(store: ReturnType<typeof createStore>): Session {
  const now = new Date().toISOString();
  const s: Session = {
    id: newId('ses'),
    title: 't',
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0
    },
    costUsd: 0,
    createdAt: now,
    updatedAt: now
  };
  store.insertSession(s);
  return s;
}

test('startGenerativeMessage streams a card: pending → delta → complete, then persists the settled row', async () => {
  const store = createStore();
  const s = seedSession(store);
  const events: Event[] = [];
  const bus = new EventBus();
  bus.subscribe(s.id, (event) => events.push(event));

  const gen = await startGenerativeMessage({
    messageIngress: createMessageIngress({ store, bus }),
    sessionId: s.id,
    type: 'card'
  });

  // Inserted pending with a reconstructable subscription source on its own channel.
  const live = store.getMessage(s.id, gen.messageId);
  expect(live?.stream.status).toBe('pending');
  expect(live?.stream.source).toEqual({ transcriptTargetId: s.id, messageId: gen.messageId });

  await gen.delta('Generating');
  await gen.delta('…done');
  await gen.complete({ text: 'Pick one', data: { title: 'Choose', actions: [{ label: 'Yes' }, { label: 'No' }] } });

  const deltas = events.filter((e) => e.type === 'session.message.delta.appended');
  expect(deltas.map((e) => parseEventPayload('session.message.delta.appended', e.payload).delta)).toEqual([
    'Generating',
    '…done'
  ]);
  expect(
    deltas.map((e) => {
      const payload = parseEventPayload('session.message.delta.appended', e.payload);
      return { producer: payload.producer, channel: payload.channel, index: payload.index, delta: payload.delta };
    })
  ).toEqual([
    {
      producer: { kind: 'system', subsystem: 'generative-message' },
      channel: gen.channel,
      index: 0,
      delta: 'Generating'
    },
    {
      producer: { kind: 'system', subsystem: 'generative-message' },
      channel: gen.channel,
      index: 1,
      delta: '…done'
    }
  ]);
  // First delta flipped the row to streaming.
  // (status is checked via the settled row below; intermediate streaming is internal.)

  const done = events.find((e) => e.type === 'session.message.completed');
  if (!done) throw new Error('missing session.message.completed');
  expect(parseEventPayload('session.message.completed', done.payload)).toMatchObject({
    producer: { kind: 'system', subsystem: 'generative-message' },
    message: { id: gen.messageId, type: 'card', text: 'Pick one', stream: { status: 'complete' } }
  });

  const settled = store.getMessage(s.id, gen.messageId);
  expect(settled?.stream.status).toBe('complete');
  expect(settled?.text).toBe('Pick one');
  expect((settled?.data as { title: string } | undefined)?.title).toBe('Choose');
  store.close();
});

test('complete() rejects data that fails the type schema and persists nothing new', async () => {
  const store = createStore();
  const s = seedSession(store);
  const events: Event[] = [];
  const bus = new EventBus();
  bus.subscribe(s.id, (event) => events.push(event));
  const gen = await startGenerativeMessage({
    messageIngress: createMessageIngress({ store, bus }),
    sessionId: s.id,
    type: 'card'
  });

  await expect(gen.complete({ text: 'bad', data: { actions: [{ label: '', url: 'nope' }] } })).rejects.toThrow();
  // Row stays pending; no complete event emitted.
  expect(store.getMessage(s.id, gen.messageId)?.stream.status).toBe('pending');
  expect(events.map((e) => e.type)).toEqual(['session.message.created']);
  store.close();
});

test('fail() settles as error with the message text', async () => {
  const store = createStore();
  const s = seedSession(store);
  const events: Event[] = [];
  const bus = new EventBus();
  bus.subscribe(s.id, (event) => events.push(event));
  const gen = await startGenerativeMessage({
    messageIngress: createMessageIngress({ store, bus }),
    sessionId: s.id,
    type: 'card'
  });

  await gen.fail('generation crashed');
  const done = events.find((e) => e.type === 'session.message.failed');
  if (!done) throw new Error('missing session.message.failed');
  expect(parseEventPayload('session.message.failed', done.payload)).toMatchObject({
    producer: { kind: 'system', subsystem: 'generative-message' },
    message: { id: gen.messageId, type: 'card', stream: { status: 'error' } }
  });
  expect(store.getMessage(s.id, gen.messageId)?.stream.status).toBe('error');
  store.close();
});
