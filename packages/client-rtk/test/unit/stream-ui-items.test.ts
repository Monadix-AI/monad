// applyUiEvent maintains a position index so per-token upserts stay O(1). These tests pin the
// behaviour the index replaced (a linear findIndex scan): correct upsert-in-place, append, removal,
// and re-add after removal, plus snapshot reset.

import type { SessionUiEvent, UIItem } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { applyUiEvent, buildIndex } from '../../src/endpoints/sessions/stream-ui-items.ts';

const item = (kind: string, id: string, extra: Record<string, unknown> = {}): UIItem =>
  ({ kind, id, ...extra }) as unknown as UIItem;
const snapshot = (items: UIItem[]): SessionUiEvent => ({ kind: 'snapshot', items }) as SessionUiEvent;
const upsert = (it: UIItem): SessionUiEvent => ({ kind: 'upsert', item: it }) as SessionUiEvent;
const remove = (kind: string, id: string): SessionUiEvent =>
  ({ kind: 'remove', target: { kind, id } }) as SessionUiEvent;

test('snapshot resets items and index', () => {
  const draft = { items: [item('message', 'old')] };
  const index = buildIndex(draft.items);
  applyUiEvent(draft, snapshot([item('message', 'a'), item('tool', 'b')]), index);
  expect(draft.items.map((i) => i.id)).toEqual(['a', 'b']);
  expect(index.get('tool:b')).toBe(1);
});

test('upsert updates in place by key, appends when new, preserving order', () => {
  const draft = { items: [] as UIItem[] };
  const index = buildIndex(draft.items);
  applyUiEvent(draft, upsert(item('message', 'm1', { seq: 1 })), index);
  applyUiEvent(draft, upsert(item('message', 'm2', { seq: 1 })), index);
  applyUiEvent(draft, upsert(item('message', 'm1', { seq: 2 })), index); // update existing
  expect(draft.items.map((i) => i.id)).toEqual(['m1', 'm2']);
  expect((draft.items[0] as unknown as { seq: number }).seq).toBe(2); // updated in place, not duplicated
  expect(draft.items).toHaveLength(2);
});

test('same id under different kinds are distinct entries', () => {
  const draft = { items: [] as UIItem[] };
  const index = buildIndex(draft.items);
  applyUiEvent(draft, upsert(item('message', 'x')), index);
  applyUiEvent(draft, upsert(item('tool', 'x')), index);
  expect(draft.items).toHaveLength(2);
});

test('remove drops the entry and keeps the index consistent for later upserts', () => {
  const draft = { items: [] as UIItem[] };
  const index = buildIndex(draft.items);
  applyUiEvent(draft, upsert(item('message', 'a')), index);
  applyUiEvent(draft, upsert(item('message', 'b')), index);
  applyUiEvent(draft, upsert(item('message', 'c')), index);
  applyUiEvent(draft, remove('message', 'a'), index); // shifts b,c down
  expect(draft.items.map((i) => i.id)).toEqual(['b', 'c']);
  // After the shift, updating 'c' must hit the right slot, not the stale pre-removal position.
  applyUiEvent(draft, upsert(item('message', 'c', { seq: 9 })), index);
  expect(draft.items.map((i) => i.id)).toEqual(['b', 'c']);
  expect((draft.items[1] as unknown as { seq: number }).seq).toBe(9);
  // Re-adding a removed id appends fresh.
  applyUiEvent(draft, upsert(item('message', 'a')), index);
  expect(draft.items.map((i) => i.id)).toEqual(['b', 'c', 'a']);
});

test('clears a prior streamError on any event', () => {
  const draft = { items: [] as UIItem[], streamError: { kind: 'transient' as const } };
  const index = buildIndex(draft.items);
  applyUiEvent(draft, upsert(item('message', 'a')), index);
});

test('snapshot captures oldestCursor and hasMore from the bounded window', () => {
  const draft: { items: UIItem[]; oldestCursor?: string; hasMore?: boolean } = { items: [] };
  const index = buildIndex(draft.items);
  const snap: SessionUiEvent = {
    kind: 'snapshot',
    items: [item('message', 'a')],
    oldestCursor: 'msg_a00000000000',
    hasMore: true
  } as SessionUiEvent;
  applyUiEvent(draft, snap, index);
  expect(draft.oldestCursor).toBe('msg_a00000000000');
  expect(draft.hasMore).toBe(true);
});

test('upsert and remove leave the snapshot cursors untouched', () => {
  const draft: { items: UIItem[]; oldestCursor?: string; hasMore?: boolean } = {
    items: [item('message', 'a')],
    oldestCursor: 'msg_a00000000000',
    hasMore: true
  };
  const index = buildIndex(draft.items);
  applyUiEvent(draft, upsert(item('message', 'b')), index);
  expect(draft.oldestCursor).toBe('msg_a00000000000');
  expect(draft.hasMore).toBe(true);
  applyUiEvent(draft, remove('message', 'b'), index);
  expect(draft.oldestCursor).toBe('msg_a00000000000');
  expect(draft.hasMore).toBe(true);
});
