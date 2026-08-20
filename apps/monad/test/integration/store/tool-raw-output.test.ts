import type { Session } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { createStore } from '#/store/db/index.ts';

function session(over: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  return {
    id: newId('ses'),
    title: 'test',
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    createdAt: now,
    updatedAt: now,
    ...over
  };
}

test('saveToolRawOutput / getToolRawOutput round-trip, scoped per session, upserts per handle', () => {
  const store = createStore();
  const s = session();
  store.insertSession(s);

  expect(store.getToolRawOutput(s.id, 'call_1')).toBeNull();

  store.saveToolRawOutput(s.id, 'call_1', 'FULL OUTPUT');
  expect(store.getToolRawOutput(s.id, 'call_1')).toBe('FULL OUTPUT');

  // Upsert on the same (session, tool_call_id) replaces, doesn't duplicate.
  store.saveToolRawOutput(s.id, 'call_1', 'REPLACED');
  expect(store.getToolRawOutput(s.id, 'call_1')).toBe('REPLACED');

  // An unrelated session sees nothing.
  const other = session();
  store.insertSession(other);
  expect(store.getToolRawOutput(other.id, 'call_1')).toBeNull();
});

test('cloneToolRawOutputs copies a branch parent’s spills so cloned tool-call handles keep resolving', () => {
  const store = createStore();
  const parent = session();
  store.insertSession(parent);
  store.saveToolRawOutput(parent.id, 'anc_call', 'ANCESTOR BYTES');
  store.saveToolRawOutput(parent.id, 'post_branch_call', 'AFTER THE BRANCH POINT');

  const child = session();
  store.insertSession(child);
  // Branching clones messages up to the branch point; the spills for the cloned tool-call ids are
  // copied alongside — but NOT ones after the branch point (their messages weren't cloned).
  store.cloneToolRawOutputs(parent.id, child.id, ['anc_call']);

  expect(store.getToolRawOutput(child.id, 'anc_call')).toBe('ANCESTOR BYTES');
  expect(store.getToolRawOutput(child.id, 'post_branch_call')).toBeNull();

  // The copies are independent: overwriting the child's does not touch the parent's.
  store.saveToolRawOutput(child.id, 'anc_call', 'CHILD OVERWRITE');
  expect(store.getToolRawOutput(parent.id, 'anc_call')).toBe('ANCESTOR BYTES');

  // A session never given a copy cannot read it.
  const sibling = session();
  store.insertSession(sibling);
  expect(store.getToolRawOutput(sibling.id, 'anc_call')).toBeNull();
});

test('deleteSession cascades tool_raw_outputs', () => {
  const store = createStore();
  const s = session();
  store.insertSession(s);
  store.saveToolRawOutput(s.id, 'call_x', 'bytes');
  expect(store.getToolRawOutput(s.id, 'call_x')).toBe('bytes');

  store.deleteSession(s.id);
  expect(store.getToolRawOutput(s.id, 'call_x')).toBeNull();
});

test('clearMessages (reset) also clears spilled tool outputs', () => {
  const store = createStore();
  const s = session();
  store.insertSession(s);
  store.insertMessage(newId('msg'), s.id, 'hi', new Date().toISOString(), 'user');
  store.saveToolRawOutput(s.id, 'call_y', 'bytes');

  store.clearMessages(s.id);
  expect(store.getToolRawOutput(s.id, 'call_y')).toBeNull();
});
