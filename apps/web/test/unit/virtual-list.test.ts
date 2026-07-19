import { expect, test } from 'bun:test';
import { averageMeasuredRowHeight, indexOfKey, overscanRowCount } from '@monad/ui/components/VirtualList';
import {
  consumeSelfTarget,
  isAtBottom,
  isLayoutInducedScroll,
  reducePinnedOnScroll,
  reduceSettleStability,
  scrollBoundaryTop,
  shouldFireEdge,
  shouldPinToBottom,
  shouldPublishAtBottomChange
} from '@monad/ui/hooks/use-bottom-follow';

test('boundary controls target the physical top and bottom of the loaded list', () => {
  const metrics = { scrollHeight: 2_400, clientHeight: 600 };

  expect([scrollBoundaryTop(metrics, 'top'), scrollBoundaryTop(metrics, 'bottom')]).toEqual([0, 1_800]);
});

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

test('reducePinnedOnScroll: a genuine move sets pinned from the at-bottom reading', () => {
  // User scrolls down but not to the bottom → unpin.
  expect(reducePinnedOnScroll(true, false, false, 'down')).toEqual({ pinned: false, selfScrollConsumed: false });
  // User scrolls back down to the bottom → re-pin.
  expect(reducePinnedOnScroll(false, false, true, 'down')).toEqual({ pinned: true, selfScrollConsumed: false });
});

test('reducePinnedOnScroll: a zero-displacement event never changes pinned', () => {
  // Our own jump's scroll event arriving after the self-scroll window, evaluated while unmeasured
  // rows make the viewport read as "not at bottom" — following must survive.
  expect([reducePinnedOnScroll(true, false, false, 'none'), reducePinnedOnScroll(false, false, true, 'none')]).toEqual([
    { pinned: true, selfScrollConsumed: false },
    { pinned: false, selfScrollConsumed: false }
  ]);
});

test('reducePinnedOnScroll: upward user scroll unpins even within the bottom threshold', () => {
  expect([reducePinnedOnScroll(true, false, true, 'up'), reducePinnedOnScroll(true, false, false, 'up')]).toEqual([
    { pinned: false, selfScrollConsumed: false },
    { pinned: false, selfScrollConsumed: false }
  ]);
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

test('overscanRowCount: px of overscan become whole rows, never zero', () => {
  expect([overscanRowCount(400, 96), overscanRowCount(600, 96), overscanRowCount(10, 96)]).toEqual([5, 7, 1]);
});

test('consumeSelfTarget: a late event at a queued destination reads as our own scroll', () => {
  const targets = [
    { top: 5424, expiresAt: 1_000 },
    { top: 6621, expiresAt: 1_000 }
  ];

  expect({
    hit: consumeSelfTarget(targets, 6620.6, 500),
    remainingAfterHit: [...targets],
    miss: consumeSelfTarget(targets, 3000, 500),
    remainingAfterMiss: [...targets]
  }).toEqual({
    // Matching 6621 also drops the stale 5424 whose event was coalesced away.
    hit: true,
    remainingAfterHit: [],
    miss: false,
    remainingAfterMiss: []
  });
});

test('consumeSelfTarget: a scroll clamped by shrinking content still matches its destination', () => {
  // scrollTo(6477) issued, then measurements shrank the list so the max became 6081: the browser
  // clamps to 6081 and the event reports that. It must read as ours, not as the user scrolling up.
  expect({
    clampedHit: consumeSelfTarget([{ top: 6477, expiresAt: 1_000 }], 6081, 500, 6081),
    userAboveMax: consumeSelfTarget([{ top: 6477, expiresAt: 1_000 }], 5000, 500, 6081)
  }).toEqual({ clampedHit: true, userAboveMax: false });
});

test('consumeSelfTarget: an expired destination cannot claim the user arriving at that position', () => {
  // The reader reaches the bottom with no gesture event to clear the queue (Tab focus moving into
  // the last row, find-in-page). A destination whose own event never arrived must not swallow that
  // arrival, or the list reports "at bottom" while silently no longer following.
  const stale = [{ top: 6621, expiresAt: 900 }];

  expect({
    beforeExpiry: consumeSelfTarget([{ top: 6621, expiresAt: 900 }], 6621, 800, 6621),
    afterExpiry: consumeSelfTarget(stale, 6621, 1_500, 6621),
    prunedQueue: stale
  }).toEqual({ beforeExpiry: true, afterExpiry: false, prunedQueue: [] });
});

test('isLayoutInducedScroll: content resizing moves the scroll position, and that is not the reader', () => {
  expect({
    // A row shrinking from its estimate makes the browser clamp the scroll it can no longer honour;
    // read as a user scroll it would unpin a reader who never touched anything.
    clampAfterShrink: isLayoutInducedScroll(false, true),
    // While the reader is actually scrolling, streaming content must not disguise their gesture.
    gestureDuringStreaming: isLayoutInducedScroll(true, true),
    // Same height: whatever moved the position, it was not the layout.
    steadyLayout: isLayoutInducedScroll(false, false)
  }).toEqual({ clampAfterShrink: true, gestureDuringStreaming: false, steadyLayout: false });
});

test('shouldFireEdge: fires on entering the zone, then only after the boundary row set changed', () => {
  expect({
    enteringZone: shouldFireEdge(true, true),
    stillInZoneDisarmed: shouldFireEdge(true, false),
    outsideZone: shouldFireEdge(false, true),
    reArmedByShortPage: shouldFireEdge(true, true)
  }).toEqual({ enteringZone: true, stillInZoneDisarmed: false, outsideZone: false, reArmedByShortPage: true });
});

test('averageMeasuredRowHeight: unmeasured lists fall back, measured lists average and round', () => {
  expect([
    averageMeasuredRowHeight([], 96),
    averageMeasuredRowHeight([106, 300, 1545, 1797], 96),
    averageMeasuredRowHeight([100, 101], 96)
  ]).toEqual([96, 937, 101]);
});

test('settle loop stops after consecutive corrected frames, and a correction restarts the count', () => {
  const first = reduceSettleStability(0, true);
  const second = reduceSettleStability(first.stableFrames, true);
  const third = reduceSettleStability(second.stableFrames, true);
  const interrupted = reduceSettleStability(second.stableFrames, false);

  expect({ first, second, third, interrupted }).toEqual({
    first: { stableFrames: 1, settled: false },
    second: { stableFrames: 2, settled: false },
    third: { stableFrames: 3, settled: true },
    interrupted: { stableFrames: 0, settled: false }
  });
});

test('bottom state hides transient non-bottom measurements while the list is still pinned', () => {
  expect([
    shouldPublishAtBottomChange(false, true, false),
    shouldPublishAtBottomChange(false, true, true),
    shouldPublishAtBottomChange(false, false, false)
  ]).toEqual([false, false, false]);
});

test('bottom state publishes true arrivals and genuine user departures', () => {
  expect([shouldPublishAtBottomChange(true, true, false), shouldPublishAtBottomChange(false, false, true)]).toEqual([
    true,
    true
  ]);
});

test('chat experience uses a stationary overscroll boundary without transform bounce', async () => {
  const [messageListSource, globalStyles] = await Promise.all([
    Bun.file(
      new URL(
        '../../../../packages/atoms/src/workspace-experiences/chat-room/components/message-list.tsx',
        import.meta.url
      )
    ).text(),
    Bun.file(new URL('../../src/styles/globals.css', import.meta.url)).text()
  ]);

  expect({
    enablesBounce: /\s bounce(?:\s|\n)/.test(messageListSource),
    overscrollRule: globalStyles.match(/\.scwf-scroll\s*\{[^}]*overscroll-behavior-y:\s*([^;]+);/s)?.[1]
  }).toEqual({ enablesBounce: false, overscrollRule: 'none' });
});
