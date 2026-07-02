import type { Event, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { createStore } from '@/store/db/index.ts';

function evt(transcriptTargetId: SessionId, type: Event['type'], payload: Record<string, unknown>): Event {
  return { id: newId('evt'), transcriptTargetId, type, actorAgentId: null, payload, at: new Date().toISOString() };
}

test('appendEvents persists and listEvents replays in id order', () => {
  const store = createStore();
  const sessionId = newId('ses') as SessionId;
  const a = evt(sessionId, 'agent.message', { text: 'one' });
  const b = evt(sessionId, 'agent.message', { text: 'two' });
  store.appendEvents([a, b]);

  const all = store.listEvents(sessionId);
  expect(all.map((e) => e.payload.text)).toEqual(['one', 'two']);

  // afterEventId is an exclusive cursor
  const after = store.listEvents(sessionId, a.id);
  expect(after.map((e) => e.id)).toEqual([b.id]);
  store.close();
});

test('appendEvents is idempotent on id (INSERT OR IGNORE)', () => {
  const store = createStore();
  const sessionId = newId('ses') as SessionId;
  const a = evt(sessionId, 'agent.message', { text: 'one' });
  store.appendEvents([a]);
  store.appendEvents([a]); // replay of same id must not duplicate
  expect(store.listEvents(sessionId)).toHaveLength(1);
  store.close();
});

test('hasEvent distinguishes persisted ids from un-persisted ones', () => {
  const store = createStore();
  const sessionId = newId('ses') as SessionId;
  const a = evt(sessionId, 'agent.message', { text: 'one' });
  store.appendEvents([a]);
  expect(store.hasEvent(a.id)).toBe(true);
  expect(store.hasEvent(newId('evt'))).toBe(false);
  store.close();
});

test('listMessages returns chat history oldest-first with roles', () => {
  const store = createStore();
  const sessionId = newId('ses') as SessionId;
  store.insertMessage(newId('msg'), sessionId, 'hi', new Date().toISOString(), 'user');
  store.insertMessage(newId('msg'), sessionId, 'hello', new Date().toISOString(), 'assistant');
  const history = store.listMessages(sessionId);
  expect(history.map((m) => m.role)).toEqual(['user', 'assistant']);
  expect(history.map((m) => m.text)).toEqual(['hi', 'hello']);
  store.close();
});
