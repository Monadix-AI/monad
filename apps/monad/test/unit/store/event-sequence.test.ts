// Scope-local event sequence allocator: monotonicity, contiguous range reservation, scope isolation,
// and watermark persistence across a reopen (crash-safety: a restart must not re-issue a number).

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStore } from '#/store/db/index.ts';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'monad-event-seq-'));
  tempDirs.push(dir);
  return join(dir, 'store.sqlite');
}

test('allocateEventSequence issues strictly increasing single numbers per scope', () => {
  const store = createStore();
  expect(store.allocateEventSequence('ses_a')).toEqual({ start: 1, end: 1 });
  expect(store.allocateEventSequence('ses_a')).toEqual({ start: 2, end: 2 });
  expect(store.allocateEventSequence('ses_a')).toEqual({ start: 3, end: 3 });
  expect(store.eventSequenceWatermark('ses_a')).toBe(3);
  store.close();
});

test('allocateEventSequence reserves a contiguous range for count > 1', () => {
  const store = createStore();
  expect(store.allocateEventSequence('ses_a', 4)).toEqual({ start: 1, end: 4 });
  expect(store.allocateEventSequence('ses_a')).toEqual({ start: 5, end: 5 });
  expect(store.allocateEventSequence('ses_a', 3)).toEqual({ start: 6, end: 8 });
  expect(store.eventSequenceWatermark('ses_a')).toBe(8);
  store.close();
});

test('scopes maintain independent counters', () => {
  const store = createStore();
  expect(store.allocateEventSequence('ses_a')).toEqual({ start: 1, end: 1 });
  expect(store.allocateEventSequence('prj_b')).toEqual({ start: 1, end: 1 });
  expect(store.allocateEventSequence('daemon')).toEqual({ start: 1, end: 1 });
  expect(store.allocateEventSequence('ses_a')).toEqual({ start: 2, end: 2 });
  expect(store.eventSequenceWatermark('prj_b')).toBe(1);
  expect(store.eventSequenceWatermark('daemon')).toBe(1);
  store.close();
});

test('eventSequenceWatermark is 0 for a scope that never allocated', () => {
  const store = createStore();
  expect(store.eventSequenceWatermark('ses_never')).toBe(0);
  store.close();
});

test('non-positive or non-integer count is rejected', () => {
  const store = createStore();
  expect(() => store.allocateEventSequence('ses_a', 0)).toThrow(RangeError);
  expect(() => store.allocateEventSequence('ses_a', -2)).toThrow(RangeError);
  expect(() => store.allocateEventSequence('ses_a', 1.5)).toThrow(RangeError);
  // A rejected allocation must not have advanced the watermark.
  expect(store.eventSequenceWatermark('ses_a')).toBe(0);
  store.close();
});

test('watermark persists across a reopen so a restart never re-issues a number', () => {
  const path = tempDbPath();
  const first = createStore({ path });
  first.allocateEventSequence('ses_a', 5);
  first.allocateEventSequence('prj_b');
  first.close();

  const reopened = createStore({ path });
  expect(reopened.eventSequenceWatermark('ses_a')).toBe(5);
  expect(reopened.eventSequenceWatermark('prj_b')).toBe(1);
  // The next allocation continues past the persisted watermark rather than restarting at 1.
  expect(reopened.allocateEventSequence('ses_a')).toEqual({ start: 6, end: 6 });
  reopened.close();
});
