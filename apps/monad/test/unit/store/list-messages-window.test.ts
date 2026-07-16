import type { Session } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { createStore } from '#/store/db/index.ts';

function session(): Session {
  const now = new Date().toISOString();
  return {
    id: newId('ses'),
    title: 'test',
    ownerPrincipalId: newId('prn'),
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    createdAt: now,
    updatedAt: now
  };
}

/** Seed n messages m1..mn in insertion (rowid) order; return their ids. */
function seed(n: number) {
  const store = createStore();
  const s = session();
  store.insertSession(s);
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) {
    const id = newId('msg');
    ids.push(id);
    store.insertMessage(id, s.id, `m${i}`, new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), 'user');
  }
  return { store, sessionId: s.id, ids };
}

const texts = (msgs: { text: string }[]) => msgs.map((m) => m.text);

test('listMessages default takes the oldest, ASC (unchanged)', () => {
  const { store, sessionId } = seed(10);
  expect(texts(store.listMessages(sessionId, { limit: 3 }))).toEqual(['m1', 'm2', 'm3']);
  expect(texts(store.listMessages(sessionId))).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10']);
  store.close();
});

test('listMessages latest takes the newest N but returns them oldest→newest', () => {
  const { store, sessionId } = seed(10);
  expect(texts(store.listMessages(sessionId, { latest: true, limit: 3 }))).toEqual(['m8', 'm9', 'm10']);
  store.close();
});

test('listMessages latest larger than total returns all, ASC', () => {
  const { store, sessionId } = seed(3);
  expect(texts(store.listMessages(sessionId, { latest: true, limit: 50 }))).toEqual(['m1', 'm2', 'm3']);
  store.close();
});

test('listMessages before+latest pages the newest window strictly older than the cursor', () => {
  const { store, sessionId, ids } = seed(10);
  // newest 3 older than m8 → m5,m6,m7
  expect(texts(store.listMessages(sessionId, { before: ids[7], latest: true, limit: 3 }))).toEqual(['m5', 'm6', 'm7']);
  store.close();
});

test('listMessages after pages the oldest window strictly newer than the cursor', () => {
  const { store, sessionId, ids } = seed(10);
  // oldest 3 newer than m5 → m6,m7,m8
  expect(texts(store.listMessages(sessionId, { after: ids[4], limit: 3 }))).toEqual(['m6', 'm7', 'm8']);
  store.close();
});

test('listMessages around opens an inclusive window centred on the anchor', () => {
  const { store, sessionId, ids } = seed(10);
  // limit 5 → half 2 → 3 at-or-older (m3,m4,m5) + 2 newer (m6,m7), INCLUDING the anchor m5
  expect(texts(store.listMessages(sessionId, { around: ids[4], limit: 5 }))).toEqual(['m3', 'm4', 'm5', 'm6', 'm7']);
  store.close();
});

test('listMessages around at the head/tail stays inclusive', () => {
  const { store, sessionId, ids } = seed(10);
  expect(texts(store.listMessages(sessionId, { around: ids[0], limit: 5 }))).toEqual(['m1', 'm2', 'm3']);
  expect(texts(store.listMessages(sessionId, { around: ids[9], limit: 5 }))).toEqual(['m8', 'm9', 'm10']);
  store.close();
});
