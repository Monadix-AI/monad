import type { Event, Session } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { startGenerativeMessage } from '@/services/generation/generative-message.ts';
import { createStore } from '@/store/db/index.ts';

function seedSession(store: ReturnType<typeof createStore>): Session {
  const now = new Date().toISOString();
  const s: Session = {
    id: newId('ses'),
    title: 't',
    ownerPrincipalId: newId('prn'),
    state: 'active',
    agentIds: [],
    parentSessionId: null,
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

test('startGenerativeMessage streams a card: pending → delta → complete, then persists the settled row', () => {
  const store = createStore();
  const s = seedSession(store);
  const events: Event[] = [];

  const gen = startGenerativeMessage({ store, emit: (e) => events.push(e), sessionId: s.id, type: 'card' });

  // Inserted pending with a reconstructable subscription source on its own channel.
  const live = store.getMessage(s.id, gen.messageId);
  expect(live?.stream.status).toBe('pending');
  expect(live?.stream.source?.channel).toBe(gen.channel);

  gen.delta('Generating');
  gen.delta('…done');
  gen.complete({ text: 'Pick one', data: { title: 'Choose', actions: [{ label: 'Yes' }, { label: 'No' }] } });

  const deltas = events.filter((e) => e.type === 'message.delta');
  expect(deltas.map((e) => e.payload.delta)).toEqual(['Generating', '…done']);
  expect(deltas.every((e) => e.payload.channel === gen.channel && e.payload.type === 'card')).toBe(true);
  // First delta flipped the row to streaming.
  // (status is checked via the settled row below; intermediate streaming is internal.)

  const done = events.find((e) => e.type === 'message.complete');
  expect(done?.payload).toMatchObject({ ok: true, type: 'card', text: 'Pick one' });

  const settled = store.getMessage(s.id, gen.messageId);
  expect(settled?.stream.status).toBe('complete');
  expect(settled?.text).toBe('Pick one');
  expect((settled?.data as { title: string }).title).toBe('Choose');
  store.close();
});

test('complete() rejects data that fails the type schema and persists nothing new', () => {
  const store = createStore();
  const s = seedSession(store);
  const events: Event[] = [];
  const gen = startGenerativeMessage({ store, emit: (e) => events.push(e), sessionId: s.id, type: 'card' });

  expect(() => gen.complete({ text: 'bad', data: { actions: [{ label: '', url: 'nope' }] } })).toThrow();
  // Row stays pending; no complete event emitted.
  expect(store.getMessage(s.id, gen.messageId)?.stream.status).toBe('pending');
  expect(events.some((e) => e.type === 'message.complete')).toBe(false);
  store.close();
});

test('fail() settles as error with the message text', () => {
  const store = createStore();
  const s = seedSession(store);
  const events: Event[] = [];
  const gen = startGenerativeMessage({ store, emit: (e) => events.push(e), sessionId: s.id, type: 'card' });

  gen.fail('generation crashed');
  const done = events.find((e) => e.type === 'message.complete');
  expect(done?.payload).toMatchObject({ ok: false, text: 'generation crashed' });
  expect(store.getMessage(s.id, gen.messageId)?.stream.status).toBe('error');
  store.close();
});
