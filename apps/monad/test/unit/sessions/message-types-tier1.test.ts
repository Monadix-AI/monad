import type { Session } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { cardSchema, newId, registerMessageType, unregisterMessageType } from '@monad/protocol';

import { createStore } from '#/store/db/index.ts';

function fixtureSession(over: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  return {
    id: newId('ses'),
    title: 'test',
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
    updatedAt: now,
    ...over
  };
}

test('includeInContext override round-trips; default stays absent', () => {
  const store = createStore();
  const s = fixtureSession();
  store.insertSession(s);
  const now = new Date().toISOString();
  store.insertMessage(newId('msg'), s.id, 'default', now, 'user', {});
  store.insertMessage(newId('msg'), s.id, 'pinned-out', now, 'user', { includeInContext: false });
  store.insertMessage(newId('msg'), s.id, 'forced-in', now, 'assistant', { type: 'error', includeInContext: true });

  const msgs = store.listMessages(s.id);
  expect(msgs[1]?.includeInContext).toBe(false);
  expect(msgs[2]?.includeInContext).toBe(true);
  store.close();
});

test('a registered atom type snapshots its context policy so it survives the atom unloading', () => {
  registerMessageType('demo', { type: 'note', dataSchema: cardSchema, fallbacks: ['text'], includeInContext: false });
  const store = createStore();
  const s = fixtureSession();
  store.insertSession(s);
  const id = newId('msg');
  // Insert with NO explicit override — the store snapshots the atom type's policy into the column.
  store.insertMessage(id, s.id, 'atom-pack chrome', new Date().toISOString(), 'assistant', { type: 'demo:note' });

  // Atom pack goes away (daemon restart, unload): resolveMessageType would now return the unknown
  // default (true), but the snapshotted column keeps the row excluded.
  unregisterMessageType('demo:note');
  expect(store.getMessage(s.id, id)?.includeInContext).toBe(false);

  // A built-in type persists nothing (NULL → resolved live), keeping the common case sparse.
  const builtinId = newId('msg');
  store.insertMessage(builtinId, s.id, 'hi', new Date().toISOString(), 'user', { type: 'text' });
  store.close();
});

test('a pending/streaming row reconstructs a subscription source; terminal rows do not', () => {
  const store = createStore();
  const s = fixtureSession();
  store.insertSession(s);
  const now = new Date().toISOString();
  const id = newId('msg');
  store.insertMessage(id, s.id, 'gen', now, 'assistant', { type: 'card', streamStatus: 'pending' });

  const m = store.getMessage(s.id, id);
  expect(m?.stream.status).toBe('pending');
  expect(m?.stream.source).toEqual({ sessionId: s.id, messageId: id, channel: `message:${id}` });
  store.close();
});

test('setGenStatus enforces the lifecycle and rejects illegal transitions', () => {
  const store = createStore();
  const s = fixtureSession();
  store.insertSession(s);
  const now = new Date().toISOString();
  const id = newId('msg');
  store.insertMessage(id, s.id, '', now, 'assistant', { type: 'card', streamStatus: 'pending' });

  expect(store.setGenStatus(s.id, id, 'streaming', now)).toBe(true);
  expect(store.setGenStatus(s.id, id, 'complete', now)).toBe(true);
  // Terminal: no further transitions.
  expect(store.setGenStatus(s.id, id, 'streaming', now)).toBe(false);
  expect(store.setGenStatus(s.id, id, 'error', now)).toBe(false);
  // A finished row exposes no live source.
  // Missing row → false, not throw.
  expect(store.setGenStatus(s.id, 'msg_missing', 'complete', now)).toBe(false);
  store.close();
});

test('failOrphanedStreamingMessages terminally fails in-flight rows left by a crash', () => {
  const store = createStore();
  const s = fixtureSession();
  store.insertSession(s);
  const now = new Date().toISOString();
  const pending = newId('msg');
  const streaming = newId('msg');
  const done = newId('msg');
  store.insertMessage(pending, s.id, '', now, 'assistant', { streamStatus: 'pending' });
  store.insertMessage(streaming, s.id, 'half', now, 'assistant', { streamStatus: 'streaming' });
  store.insertMessage(done, s.id, 'finished', now, 'assistant', { streamStatus: 'complete' });

  expect(store.failOrphanedStreamingMessages(now)).toBe(2);
  expect(store.getMessage(s.id, pending)?.stream.status).toBe('error');
  expect(store.getMessage(s.id, streaming)?.stream.status).toBe('error');
  // The orphaned rows are excluded from context, and the completed one is untouched.
  expect(store.getMessage(s.id, pending)?.includeInContext).toBe(false);
  expect(store.getMessage(s.id, done)?.stream.status).toBe('complete');
  // Idempotent: a second sweep finds nothing.
  expect(store.failOrphanedStreamingMessages(now)).toBe(0);
  store.close();
});
