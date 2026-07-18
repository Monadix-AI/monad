import { expect, test } from 'bun:test';
import { observationFollowResetKey } from '@monad/atoms/workspace-experiences';
import {
  indexOfKey,
  initialBottomScrollRequest,
  initialBottomScrollRequestFor,
  isAtBottom,
  reduceBottomScrollRequest,
  reducePinnedOnScroll,
  scrollBoundaryTop,
  scrollTopPreservingAnchor,
  shouldPinToBottom,
  shouldPublishAtBottomChange
} from '@monad/ui/components/VirtualList';

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

test('scroll target uses Virtuoso absolute indexes when history has been prepended', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const getKey = (item: { id: string }) => item.id;

  expect([indexOfKey(items, getKey, 'b', 999_980), indexOfKey(items, getKey, 'missing', 999_980)]).toEqual([
    999_981, -1
  ]);
});

test('reducePinnedOnScroll: a genuine scroll sets pinned from the at-bottom reading', () => {
  // User scrolls up away from the bottom → unpin.
  expect(reducePinnedOnScroll(true, false, false)).toEqual({ pinned: false, selfScrollConsumed: false });
  // User scrolls back to the bottom → re-pin.
  expect(reducePinnedOnScroll(false, false, true)).toEqual({ pinned: true, selfScrollConsumed: false });
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

test('bottom request smooth-scrolls first and auto-corrects after virtual height changes', () => {
  const requested = reduceBottomScrollRequest(initialBottomScrollRequest, {
    type: 'request',
    behavior: 'smooth'
  });

  expect(requested).toEqual({ active: true, behavior: 'smooth' });
  expect(reduceBottomScrollRequest(requested, { type: 'height-changed' })).toEqual({
    active: true,
    behavior: 'auto'
  });
  expect(reduceBottomScrollRequest(requested, { type: 'settle-timeout' })).toEqual({
    active: true,
    behavior: 'auto'
  });
});

test('non-empty bottom-following lists start with an active settlement request', () => {
  expect([
    initialBottomScrollRequestFor(true, false, 30),
    initialBottomScrollRequestFor(true, true, 30),
    initialBottomScrollRequestFor(true, false, 0),
    initialBottomScrollRequestFor(false, false, 30)
  ]).toEqual([
    { active: true, behavior: 'auto' },
    initialBottomScrollRequest,
    initialBottomScrollRequest,
    initialBottomScrollRequest
  ]);
});

test('bottom request cancels only on upward user scroll', () => {
  const requested = reduceBottomScrollRequest(initialBottomScrollRequest, {
    type: 'request',
    behavior: 'smooth'
  });

  expect(reduceBottomScrollRequest(requested, { type: 'user-scroll-up' })).toEqual(initialBottomScrollRequest);
});

test('bottom request ends after the true bottom stays stable', () => {
  const requested = reduceBottomScrollRequest(initialBottomScrollRequest, {
    type: 'request',
    behavior: 'auto'
  });
  const measuring = reduceBottomScrollRequest(requested, { type: 'height-changed' });

  expect(
    reduceBottomScrollRequest(measuring, {
      type: 'stable-at-bottom'
    })
  ).toEqual(initialBottomScrollRequest);
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

test('scrollTopPreservingAnchor: offsets list scrolling so an expanded title keeps its viewport position', () => {
  expect(scrollTopPreservingAnchor(640, 120, 72)).toBe(592);
  expect(scrollTopPreservingAnchor(640, 120, 120)).toBe(640);
  expect(scrollTopPreservingAnchor(640, 120, 168)).toBe(688);
});

test('observationFollowResetKey: streaming text changes do not request an imperative scroll reset', () => {
  // `observationFollowResetKey` only keys off `id`/`status`; callers pass the full stream (with
  // `items`), so the fixture is typed as the wider shape to prove extra fields don't affect the key.
  const base: { id: string; status: string; items: { id: string; text: string }[] } = {
    id: 'exa_codex0000000',
    status: 'running',
    items: [{ id: 'item_1', text: 'hello' }]
  };
  const streamingUpdate: typeof base = { ...base, items: [{ id: 'item_1', text: 'hello world' }] };
  const otherStream: typeof base = { ...base, id: 'exa_other0000000' };

  expect(observationFollowResetKey(streamingUpdate)).toBe(observationFollowResetKey(base));
  expect(observationFollowResetKey(otherStream)).not.toBe(observationFollowResetKey(base));
});
