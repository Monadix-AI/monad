import type { Session } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { createStore } from '#/store/db/index.ts';

function session(over: Partial<Session> = {}): Session {
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
    updatedAt: now,
    ...over
  };
}

// Backs the daemon's SummaryStore (durable rolling summary + boundary).
test('getMemory/setMemory round-trip and upsert per (session, key)', () => {
  const store = createStore();
  const s = session();
  store.insertSession(s);

  store.setMemory(s.id, 'ctx:summary', JSON.stringify({ summary: 'A', uptoMessageId: 'm1' }));
  expect(JSON.parse(store.getMemory(s.id, 'ctx:summary') as string)).toEqual({ summary: 'A', uptoMessageId: 'm1' });

  // Upsert replaces, doesn't duplicate.
  store.setMemory(s.id, 'ctx:summary', JSON.stringify({ summary: 'B', uptoMessageId: 'm5' }));
  expect(JSON.parse(store.getMemory(s.id, 'ctx:summary') as string)).toEqual({ summary: 'B', uptoMessageId: 'm5' });

  // Scoped per session.
});

test('clearMessages drops the durable context summary', () => {
  const store = createStore();
  const s = session();
  store.insertSession(s);
  store.insertMessage(newId('msg'), s.id, 'hello', new Date().toISOString(), 'user');
  store.setMemory(
    s.id,
    'ctx:summary',
    JSON.stringify({ summary: 'Earlier context.', uptoMessageId: 'msg_100000000000' })
  );
  store.setMemory(s.id, 'other', 'keep');

  expect(store.clearMessages(s.id)).toBe(1);
  expect(store.getMemory(s.id, 'other')).toBe('keep');
});

test('restore drops durable context summary when rewinding before the summary boundary', () => {
  const store = createStore();
  const s = session();
  store.insertSession(s);
  const ids = ['first', 'second', 'third'].map((text) => {
    const id = newId('msg');
    store.insertMessage(id, s.id, text, new Date().toISOString(), 'user');
    return id;
  });
  store.setMemory(s.id, 'ctx:summary', JSON.stringify({ summary: 'covered first two', uptoMessageId: ids[1] }));
  store.setMemory(s.id, 'other', 'keep');

  store.restoreMessages(s.id, ids[0] as string);

  expect(store.getMemory(s.id, 'other')).toBe('keep');
});

test('restore keeps durable context summary when rewinding after the summary boundary', () => {
  const store = createStore();
  const s = session();
  store.insertSession(s);
  const ids = ['first', 'second', 'third'].map((text) => {
    const id = newId('msg');
    store.insertMessage(id, s.id, text, new Date().toISOString(), 'user');
    return id;
  });
  store.setMemory(s.id, 'ctx:summary', JSON.stringify({ summary: 'covered first', uptoMessageId: ids[0] }));

  store.restoreMessages(s.id, ids[2] as string);

  expect(JSON.parse(store.getMemory(s.id, 'ctx:summary') as string)).toEqual({
    summary: 'covered first',
    uptoMessageId: ids[0]
  });
});

// Backs the daemon's DurableSummarizer MessageSource.listSince (bounded load).
test('listMessages({ after }) returns only messages strictly after the cursor', () => {
  const store = createStore();
  const s = session();
  store.insertSession(s);
  const ids = ['m1', 'm2', 'm3', 'm4'].map((t) => {
    const id = newId('msg');
    store.insertMessage(id, s.id, t, new Date().toISOString(), 'user');
    return id;
  });

  const after2 = store.listMessages(s.id, { after: ids[1] }).map((m) => m.text);
  expect(after2).toEqual(['m3', 'm4']); // strictly after the 2nd message

  // Last message → empty; unknown cursor → everything (0 floor).
  expect(store.listMessages(s.id, { after: 'msg_nonexistent0' })).toHaveLength(4);
});
