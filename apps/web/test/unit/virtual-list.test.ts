import { expect, test } from 'bun:test';

import { indexOfKey, isAtBottom, reducePinnedOnScroll } from '../../components/ui/VirtualList.tsx';

test('isAtBottom: at the exact bottom', () => {
  expect(isAtBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 })).toBe(true);
});

test('isAtBottom: within the default threshold counts as at-bottom', () => {
  // 119px from the bottom (< 120 default)
  expect(isAtBottom({ scrollHeight: 1000, scrollTop: 381, clientHeight: 500 })).toBe(true);
  // 121px from the bottom (> 120 default)
  expect(isAtBottom({ scrollHeight: 1000, scrollTop: 379, clientHeight: 500 })).toBe(false);
});

test('isAtBottom: honors a custom threshold', () => {
  const metrics = { scrollHeight: 1000, scrollTop: 460, clientHeight: 500 }; // 40px from bottom
  expect(isAtBottom(metrics, 30)).toBe(false);
  expect(isAtBottom(metrics, 50)).toBe(true);
});

test('indexOfKey: finds and misses', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const getKey = (i: { id: string }) => i.id;
  expect(indexOfKey(items, getKey, 'b')).toBe(1);
  expect(indexOfKey(items, getKey, 'zzz')).toBe(-1);
  expect(indexOfKey([], getKey, 'a')).toBe(-1);
});

test('reducePinnedOnScroll: a genuine scroll sets pinned from the at-bottom reading', () => {
  // User scrolls up away from the bottom → unpin.
  expect(reducePinnedOnScroll(true, false, false)).toEqual({ pinned: false, selfScrollConsumed: false });
  // User scrolls back to the bottom → re-pin.
  expect(reducePinnedOnScroll(false, false, true)).toEqual({ pinned: true, selfScrollConsumed: false });
});

test('reducePinnedOnScroll: our own pinning scroll is ignored and consumes the flag', () => {
  // A self-scroll while pinned must NOT flip pinned, even though we are momentarily not
  // at the bottom (content just grew); it only consumes the one-shot flag.
  expect(reducePinnedOnScroll(true, true, false)).toEqual({ pinned: true, selfScrollConsumed: true });
  // A self-scroll while unpinned must NOT silently re-pin the user.
  expect(reducePinnedOnScroll(false, true, true)).toEqual({ pinned: false, selfScrollConsumed: true });
});
