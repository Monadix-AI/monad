import type { Database } from 'bun:sqlite';
import type { Event, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId, parseEventPayload } from '@monad/protocol';

import { createStore } from '#/store/db/index.ts';

function evt(sessionId: SessionId, type: Event['type'], payload: Record<string, unknown>): Event {
  return { id: newId('evt'), sessionId, type, actorAgentId: null, payload, at: new Date().toISOString() };
}

function completedEvent(sessionId: SessionId, text: string): Event {
  const messageId = newId('msg');
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

test('appendEvents persists and listEvents replays in id order', () => {
  const store = createStore();
  const sessionId = newId('ses') as SessionId;
  const a = completedEvent(sessionId, 'one');
  const b = completedEvent(sessionId, 'two');
  store.appendEvents([a, b]);

  const all = store.listEvents(sessionId);
  expect(all.map((e) => parseEventPayload('session.message.completed', e.payload).message.text)).toEqual([
    'one',
    'two'
  ]);

  // afterEventId is an exclusive cursor
  const after = store.listEvents(sessionId, a.id);
  expect(after.map((e) => e.id)).toEqual([b.id]);
  store.close();
});

test('appendEvents is idempotent on id (INSERT OR IGNORE)', () => {
  const store = createStore();
  const sessionId = newId('ses') as SessionId;
  const a = completedEvent(sessionId, 'one');
  store.appendEvents([a]);
  store.appendEvents([a]); // replay of same id must not duplicate
  expect(store.listEvents(sessionId)).toHaveLength(1);
  store.close();
});

test('appendEvents rejects a payload that violates its event type contract', () => {
  const store = createStore();
  const sessionId = newId('ses') as SessionId;
  const invalid = evt(sessionId, 'mesh.resume_failed', {
    agentName: 'reviewer',
    provider: 'claude-code',
    providerSessionRef: 'thread-42',
    message: 'resume failed',
    fallback: 'cold-start'
  });

  expect(() => store.appendEvents([invalid])).toThrow('Invalid input: expected string, received undefined');
  expect(store.listEvents(sessionId)).toEqual([]);
  store.close();
});

test('listEvents rejects a persisted payload that violates its event type contract', () => {
  const store = createStore();
  const sqlite = (store as unknown as { sqlite: Database }).sqlite;
  const sessionId = newId('ses') as SessionId;
  sqlite
    .query(
      'INSERT INTO events (id, transcript_target_id, type, actor_agent_id, payload, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
    )
    .run(
      newId('evt'),
      sessionId,
      'mesh.resume_failed',
      null,
      JSON.stringify({
        agentName: 'reviewer',
        provider: 'claude-code',
        providerSessionRef: 'thread-42',
        message: 'resume failed',
        fallback: 'cold-start'
      }),
      '2026-07-20T00:00:00.000Z'
    );

  expect(() => store.listEvents(sessionId)).toThrow('Invalid input: expected string, received undefined');
  store.close();
});

test('event cursors are valid only inside their transcript', () => {
  const store = createStore();
  const sessionId = newId('ses') as SessionId;
  const otherSessionId = newId('ses') as SessionId;
  const first = completedEvent(sessionId, 'one');
  const foreign = completedEvent(otherSessionId, 'foreign');
  const second = completedEvent(sessionId, 'two');
  store.appendEvents([first, foreign, second]);

  expect(store.hasEvent(sessionId, first.id)).toBe(true);
  expect(store.hasEvent(sessionId, foreign.id)).toBe(false);
  expect(store.hasEvent(sessionId, newId('evt'))).toBe(false);
  expect(store.listEvents(sessionId, foreign.id).map((event) => event.id)).toEqual([first.id, second.id]);
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
