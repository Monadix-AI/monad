import { expect, test } from 'bun:test';

import { createInboxExposureTracker } from '#/features/inbox/exposure';

test('marks an item read only after one continuous visible dwell', () => {
  const callbacks = new Map<number, () => void>();
  const seen: string[] = [];
  let next = 0;
  const tracker = createInboxExposureTracker({
    dwellMs: 500,
    onSeen: (key) => seen.push(key),
    schedule: (callback) => {
      callbacks.set(++next, callback);
      return next;
    },
    cancel: (handle) => callbacks.delete(handle as number)
  });

  tracker.setVisible('mention:1', true);
  tracker.setVisible('mention:1', false);
  for (const callback of callbacks.values()) callback();
  expect(seen).toEqual([]);

  tracker.setVisible('mention:1', true);
  for (const callback of [...callbacks.values()]) callback();
  expect(seen).toEqual(['mention:1']);
  tracker.setVisible('mention:1', true);
  for (const callback of callbacks.values()) callback();
  expect(seen).toEqual(['mention:1']);
});

test('page visibility cancels dwell until the item is visibly observed again', () => {
  const callbacks = new Map<number, () => void>();
  const seen: string[] = [];
  let next = 0;
  const tracker = createInboxExposureTracker({
    dwellMs: 500,
    onSeen: (key) => seen.push(key),
    schedule: (callback) => {
      callbacks.set(++next, callback);
      return next;
    },
    cancel: (handle) => callbacks.delete(handle as number)
  });

  tracker.setVisible('hitl:1', true);
  tracker.setPageVisible(false);
  for (const callback of callbacks.values()) callback();
  expect(seen).toEqual([]);
  tracker.setPageVisible(true);
  for (const callback of callbacks.values()) callback();
  expect(seen).toEqual(['hitl:1']);
});
