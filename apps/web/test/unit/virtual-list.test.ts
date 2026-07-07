import { expect, test } from 'bun:test';
import { observationFollowResetKey } from '@monad/atoms/workspace-experiences';
import { indexOfKey, isAtBottom, reducePinnedOnScroll, shouldPinToBottom } from '@monad/ui/components/VirtualList';

test('isAtBottom: at the exact bottom', () => {
  expect(isAtBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 })).toBe(true);
});

test('isAtBottom: within the default threshold counts as at-bottom', () => {
  // 31px from the bottom (< 32 default)
  expect(isAtBottom({ scrollHeight: 1000, scrollTop: 469, clientHeight: 500 })).toBe(true);
  // 33px from the bottom (> 32 default)
  expect(isAtBottom({ scrollHeight: 1000, scrollTop: 467, clientHeight: 500 })).toBe(false);
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

test('reducePinnedOnScroll: upward user scroll unpins even within the bottom threshold', () => {
  expect(reducePinnedOnScroll(true, false, true, 'up')).toEqual({ pinned: false, selfScrollConsumed: false });
});

test('reducePinnedOnScroll: our own pinning scroll is ignored and consumes the flag', () => {
  // A self-scroll while pinned must NOT flip pinned, even though we are momentarily not
  // at the bottom (content just grew); it only consumes the one-shot flag.
  expect(reducePinnedOnScroll(true, true, false)).toEqual({ pinned: true, selfScrollConsumed: true });
  // A self-scroll while unpinned must NOT silently re-pin the user.
  expect(reducePinnedOnScroll(false, true, true)).toEqual({ pinned: false, selfScrollConsumed: true });
});

test('shouldPinToBottom: follows viewport changes unless the user is parked above the bottom', () => {
  expect(shouldPinToBottom(true, true)).toBe(true);
  expect(shouldPinToBottom(true, false)).toBe(false);
  expect(shouldPinToBottom(false, true)).toBe(false);
});

test('observationFollowResetKey: streaming text changes do not request an imperative scroll reset', () => {
  // `observationFollowResetKey` only keys off `id`/`status`; callers pass the full stream (with
  // `items`), so the fixture is typed as the wider shape to prove extra fields don't affect the key.
  const base: { id: string; status: string; items: { id: string; text: string }[] } = {
    id: 'ncli_codex',
    status: 'running',
    items: [{ id: 'item_1', text: 'hello' }]
  };
  const streamingUpdate: typeof base = { ...base, items: [{ id: 'item_1', text: 'hello world' }] };
  const otherStream: typeof base = { ...base, id: 'ncli_other' };

  expect(observationFollowResetKey(streamingUpdate)).toBe(observationFollowResetKey(base));
  expect(observationFollowResetKey(otherStream)).not.toBe(observationFollowResetKey(base));
});
