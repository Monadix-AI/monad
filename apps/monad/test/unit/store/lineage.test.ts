import type { MessageId, Session } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { createStore } from '@/store/db/index.ts';

function session(over: Partial<Session> = {}): Session {
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
    createdAt: now,
    updatedAt: now,
    ...over
  };
}

test('listMessagesWithLineage returns own messages for a root session', () => {
  const store = createStore();
  const s = session();
  store.insertSession(s);
  store.insertMessage(newId('msg'), s.id, 'hello', new Date().toISOString(), 'user');

  const hist = store.listMessagesWithLineage(s.id);
  expect(hist.map((m) => m.text)).toEqual(['hello']);
  store.close();
});

test('listMessagesWithLineage inherits ancestor history up to the branch point', () => {
  const store = createStore();
  const parent = session();
  store.insertSession(parent);
  const m1 = newId('msg');
  const m2 = newId('msg');
  store.insertMessage(m1, parent.id, 'p1', new Date().toISOString(), 'user');
  store.insertMessage(m2, parent.id, 'p2', new Date().toISOString(), 'assistant');
  store.insertMessage(newId('msg'), parent.id, 'p3-after-branch', new Date().toISOString(), 'user');

  // Child branched at m2 → should inherit p1, p2 (not p3) plus its own messages.
  const child = session({ parentSessionId: parent.id, branchedAtMessageId: m2 as MessageId });
  store.insertSession(child);
  store.insertMessage(newId('msg'), child.id, 'c1', new Date().toISOString(), 'user');

  const hist = store.listMessagesWithLineage(child.id).map((m) => m.text);
  expect(hist).toEqual(['p1', 'p2', 'c1']); // p3 (after the branch point) is excluded
  store.close();
});

test('listMessagesWithLineage({ after }) slices the FULL lineage — boundary may be in an ancestor', () => {
  const store = createStore();
  const parent = session();
  store.insertSession(parent);
  const m1 = newId('msg');
  const m2 = newId('msg');
  store.insertMessage(m1, parent.id, 'p1', new Date().toISOString(), 'user');
  store.insertMessage(m2, parent.id, 'p2', new Date().toISOString(), 'assistant');

  const child = session({ parentSessionId: parent.id, branchedAtMessageId: m2 as MessageId });
  store.insertSession(child);
  const c1 = newId('msg');
  store.insertMessage(c1, child.id, 'c1', new Date().toISOString(), 'user');
  store.insertMessage(newId('msg'), child.id, 'c2', new Date().toISOString(), 'assistant');

  // Boundary in the ANCESTOR (m1): a per-session cursor would drop p2; lineage slice keeps it.
  expect(store.listMessagesWithLineage(child.id, { after: m1 }).map((m) => m.text)).toEqual(['p2', 'c1', 'c2']);
  // Boundary at the branch point (m2): only the child's own messages remain.
  expect(store.listMessagesWithLineage(child.id, { after: m2 }).map((m) => m.text)).toEqual(['c1', 'c2']);
  // Boundary in the child (c1).
  expect(store.listMessagesWithLineage(child.id, { after: c1 }).map((m) => m.text)).toEqual(['c2']);
  // Unknown cursor → everything (matches listMessages after semantics).
  expect(store.listMessagesWithLineage(child.id, { after: 'msg_nope' }).map((m) => m.text)).toEqual([
    'p1',
    'p2',
    'c1',
    'c2'
  ]);
  store.close();
});
