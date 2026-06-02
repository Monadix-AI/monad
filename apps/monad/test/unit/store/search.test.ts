import type { Session } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { createStore } from '@/store/db/index.ts';

function seedSession(store: ReturnType<typeof createStore>, title: string): Session {
  const now = new Date().toISOString();
  const s: Session = {
    id: newId('ses'),
    title,
    ownerPrincipalId: newId('prn'),
    state: 'active',
    agentIds: [],
    parentSessionId: null,
    archived: false,
    restoreCount: 0,
    createdAt: now,
    updatedAt: now
  };
  store.insertSession(s);
  return s;
}

test('keyword search finds ASCII word matches with session context', () => {
  const store = createStore();
  const s = seedSession(store, 'Deploy notes');
  store.insertMessage(
    newId('msg'),
    s.id,
    'We should deploy the streaming search feature',
    new Date().toISOString(),
    'user'
  );
  store.insertMessage(newId('msg'), s.id, 'unrelated chatter about lunch', new Date().toISOString(), 'assistant');

  const hits = store.searchMessages({ q: 'streaming' });
  expect(hits.length).toBe(1);
  expect(hits[0]?.sessionTitle).toBe('Deploy notes');
  expect(hits[0]?.snippet).toContain('streaming');
  expect(hits[0]?.matchedBy).toBe('keyword');
});

test('trigram path recalls CJK substrings (>= 3 chars)', () => {
  const store = createStore();
  const s = seedSession(store, '中文会话');
  store.insertMessage(newId('msg'), s.id, '今天天气很好我们去公园散步', new Date().toISOString(), 'user');

  const hits = store.searchMessages({ q: '天气很' });
  expect(hits.length).toBe(1);
  expect(hits[0]?.snippet).toContain('天气很');
});

test('short queries fall back to LIKE', () => {
  const store = createStore();
  const s = seedSession(store, 'x');
  store.insertMessage(newId('msg'), s.id, 'café au lait', new Date().toISOString(), 'user');
  const hits = store.searchMessages({ q: 'au' });
  expect(hits.length).toBe(1);
});

test('search excludes soft-deleted (restored) messages and respects sessionId scope', () => {
  const store = createStore();
  const a = seedSession(store, 'A');
  const b = seedSession(store, 'B');
  const m1 = newId('msg');
  store.insertMessage(m1, a.id, 'shared keyword apples', new Date().toISOString(), 'user');
  store.insertMessage(newId('msg'), b.id, 'shared keyword apples', new Date().toISOString(), 'user');

  expect(store.searchMessages({ q: 'apples' }).length).toBe(2);
  expect(store.searchMessages({ q: 'apples', sessionId: a.id }).length).toBe(1);

  store.restoreMessages(a.id, m1); // soft-delete a's message
  expect(store.searchMessages({ q: 'apples', sessionId: a.id }).length).toBe(0);
});
