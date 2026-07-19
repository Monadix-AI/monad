import type { KeyboardEvent, PointerEvent, RefObject } from 'react';

import { useCallback, useEffect, useRef } from 'react';

/** Px from the true bottom within which the user still counts as "pinned". */
export const STICK_THRESHOLD = 32;
/** Px from the bottom that still counts as the exact bottom while a landing settles. */
const TRUE_BOTTOM_THRESHOLD = 1;
/** Upper bound on how long a bottom landing keeps correcting itself as rows measure. */
const BOTTOM_SETTLE_MS = 1_000;
/** Consecutive frames needing no correction before a landing counts as settled. */
const SETTLE_STABLE_FRAMES = 3;
/** Settle tick spacing when the document is hidden and rAF is frozen. */
export const HIDDEN_SETTLE_INTERVAL_MS = 50;
/** Px from either edge that arms the load-older / load-newer callbacks. */
const EDGE_THRESHOLD = 240;
/** How long scroll events stay attributable to our own pinning, per behaviour. */
const SELF_SCROLL_WINDOW_MS = { auto: 120, smooth: 700 } as const;
/** Max queued programmatic scroll destinations awaiting their (possibly late) events. */
const SELF_TARGET_LIMIT = 8;
/** How long a queued destination stays eligible to claim a scroll event as ours. */
const SELF_TARGET_TTL_MS = 1_000;
/** Px tolerance when matching a scroll event's position against a queued destination. */
const SELF_TARGET_TOLERANCE = 1.5;
/** How long after a gesture its scroll events keep arriving (wheel momentum, key repeat). */
const USER_SCROLL_INTENT_MS = 300;
const SCROLL_KEYS = new Set(['ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp', ' ']);

export type ScrollMetrics = { scrollHeight: number; scrollTop: number; clientHeight: number };

/** A programmatic scroll we (or the virtualizer) issued, still waiting for its scroll event. */
export type SelfScrollTarget = { top: number; expiresAt: number };

/** True when the scroll position is within `threshold` px of the very bottom. */
export function isAtBottom(metrics: ScrollMetrics, threshold = STICK_THRESHOLD): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

export function scrollBoundaryTop(
  metrics: { scrollHeight: number; clientHeight: number },
  boundary: 'top' | 'bottom'
): number {
  return boundary === 'top' ? 0 : Math.max(0, metrics.scrollHeight - metrics.clientHeight);
}

/**
 * Decide the next pinned state for a scroll event. Two kinds of event carry no user intent and
 * must not change pinned: one we caused ourselves (pinning would otherwise read as the user
 * arriving at the bottom), and one with zero displacement (our own earlier jump's event arriving
 * after the self-scroll window — a real user scroll always moves the position). Genuine moves set
 * pinned from whether the viewport is at the bottom; any genuine upward move unpins.
 */
export function reducePinnedOnScroll(
  prevPinned: boolean,
  selfScroll: boolean,
  atBottom: boolean,
  direction: 'up' | 'down' | 'none' = 'none'
): { pinned: boolean; selfScrollConsumed: boolean } {
  if (selfScroll) return { pinned: prevPinned, selfScrollConsumed: true };
  if (direction === 'none') return { pinned: prevPinned, selfScrollConsumed: false };
  if (direction === 'up') return { pinned: false, selfScrollConsumed: false };
  return { pinned: atBottom, selfScrollConsumed: false };
}

export function shouldPinToBottom(stickToBottom: boolean, pinned: boolean): boolean {
  return stickToBottom && pinned;
}

export function shouldPublishAtBottomChange(nextAtBottom: boolean, pinned: boolean, userScrolled: boolean): boolean {
  return nextAtBottom || (!pinned && userScrolled);
}

/**
 * Match a scroll event's position against the queued programmatic destinations. A hit identifies
 * the event as our own (or the virtualizer's) doing no matter how late the browser delivers it,
 * and consumes the matched target plus everything queued before it (those are stale — their events
 * were coalesced away). A destination beyond the CURRENT maximum also matches an event sitting at
 * that maximum: the content shrank between the write and the event, so the browser clamped our
 * scroll — without this the clamped position reads as the user scrolling up and kills following.
 *
 * Targets expire, and that expiry is what keeps this honest: an unclaimed destination left in the
 * queue forever would eventually swallow the user's own arrival at that same position (reaching
 * the bottom by Tab-focus or find-in-page fires no gesture event to clear the queue), leaving the
 * list reporting "at bottom" while no longer following anything.
 */
export function consumeSelfTarget(
  targets: SelfScrollTarget[],
  scrollTop: number,
  now: number,
  maxScrollTop = Number.POSITIVE_INFINITY,
  tolerance = SELF_TARGET_TOLERANCE
): boolean {
  let live = 0;
  for (const target of targets) {
    if (target.expiresAt > now) targets[live++] = target;
  }
  targets.length = live;

  const atMax = Math.abs(scrollTop - maxScrollTop) <= tolerance;
  const index = targets.findIndex(
    (target) => Math.abs(target.top - scrollTop) <= tolerance || (atMax && target.top >= maxScrollTop - tolerance)
  );
  if (index < 0) return false;
  targets.splice(0, index + 1);
  return true;
}

/**
 * Whether a scroll event was caused by the layout rather than the reader. Content changing height
 * moves the scroll position on its own — most sharply when a row shrinks from its estimate and the
 * browser clamps the scroll it cannot honour any more. Without this an intermediate clamp lands as
 * an "upward move", unpins a reader who never touched anything, and following dies for good.
 *
 * A gesture wins over the height signal: while the reader is actually scrolling, content that
 * happens to be streaming must not make their scroll look layout-induced.
 */
export function isLayoutInducedScroll(gestureActive: boolean, scrollHeightChanged: boolean): boolean {
  return !gestureActive && scrollHeightChanged;
}

/**
 * Settle-loop frame verdict: a landing is settled once enough consecutive frames needed no
 * correction. Without this the loop polls layout (forced reflow) every frame for its full window
 * even though a landing typically holds within a few frames.
 */
export function reduceSettleStability(
  stableFrames: number,
  atExactBottom: boolean
): { stableFrames: number; settled: boolean } {
  const next = atExactBottom ? stableFrames + 1 : 0;
  return { stableFrames: next, settled: next >= SETTLE_STABLE_FRAMES };
}

/**
 * Whether an edge callback should fire: only on entering the zone, or when the boundary row itself
 * changed. Without the second clause a page of older rows too short to push the reader out of the
 * top zone would leave the list armed-off forever, stalling reverse pagination.
 */
export function shouldFireEdge(inZone: boolean, armed: boolean): boolean {
  return inZone && armed;
}

export type BottomFollow = {
  handleScroll: () => void;
  handleKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  handlePointerDown: (event: PointerEvent<HTMLElement>) => void;
  markUserScrollIntent: () => void;
  /** Flag a programmatic scroll before it happens so its event is not read as the user's. */
  markSelfScroll: (behavior: 'auto' | 'smooth', target?: number) => void;
  scrollToBottomNow: (behavior: 'auto' | 'smooth') => void;
  /** Repeat the bottom landing until it holds; returns a cancel function. */
  settleAtBottom: () => () => void;
  evaluateEdges: () => void;
  /** Re-arm the edge callbacks after the row set changed at that edge. */
  armEdges: () => void;
  scrollToTop: (behavior: 'auto' | 'smooth') => void;
  releaseToUser: () => void;
  pinnedRef: RefObject<boolean>;
  userScrolledRef: RefObject<boolean>;
};

/**
 * Bottom-following state for a scroll container: whether the READER still wants to sit at the
 * bottom, and the scrolling needed to keep them there. Deliberately separate from any virtualizer
 * — the library keeps the viewport steady through row measurement, this decides whether it should.
 */
export function useBottomFollow({
  scrollerRef,
  stickToBottom,
  onAtBottomChange,
  onStartReached,
  onEndReached
}: {
  scrollerRef: RefObject<HTMLDivElement | null>;
  stickToBottom: boolean;
  onAtBottomChange?: (atBottom: boolean) => void;
  onStartReached?: () => void;
  onEndReached?: () => void;
}): BottomFollow {
  // Detection rests on one fact: content growth does NOT fire a scroll event — only the user, our
  // own pinning, and the virtualizer's corrections move the scrollbar. Programmatic scrolls are
  // recognized two ways: by TARGET (every known destination is queued and matched against the
  // event's position — robust even when the browser delivers the event hundreds of ms late) and by
  // a short time window (needed for smooth scrolls, which pass through many intermediate
  // positions no queued target predicts).
  const pinnedRef = useRef(true);
  const userScrolledRef = useRef(false);
  const selfScrollUntilRef = useRef(0);
  const selfTargetsRef = useRef<SelfScrollTarget[]>([]);
  const lastScrollTopRef = useRef<number | null>(null);
  const lastScrollHeightRef = useRef<number | null>(null);
  const userIntentUntilRef = useRef(0);
  const publishedAtBottomRef = useRef<boolean | null>(null);
  const startArmedRef = useRef(true);
  const endArmedRef = useRef(true);

  const markSelfScroll = useCallback((behavior: 'auto' | 'smooth', target?: number) => {
    const now = performance.now();
    selfScrollUntilRef.current = now + SELF_SCROLL_WINDOW_MS[behavior];
    if (target === undefined) return;
    const targets = selfTargetsRef.current;
    targets.push({ top: target, expiresAt: now + SELF_TARGET_TTL_MS });
    if (targets.length > SELF_TARGET_LIMIT) targets.splice(0, targets.length - SELF_TARGET_LIMIT);
  }, []);

  // A real gesture ends the self-scroll grace window at once, so a mid-flight smooth scroll can
  // never swallow the scroll events that gesture produces. It also invalidates queued
  // destinations: a canceled smooth scroll must not let its never-reached target later swallow the
  // user's own return to that position.
  const markUserScrollIntent = useCallback(() => {
    userIntentUntilRef.current = performance.now() + USER_SCROLL_INTENT_MS;
    selfScrollUntilRef.current = 0;
    selfTargetsRef.current.length = 0;
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (SCROLL_KEYS.has(event.key)) markUserScrollIntent();
    },
    [markUserScrollIntent]
  );

  // Only a press on the scroll container ITSELF (the scrollbar) is scroll intent. A press on a row
  // — expanding a tool card, selecting text — must not clear the self-scroll bookkeeping, or the
  // correction already in flight lands unrecognized and silently cancels following mid-stream.
  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (event.target === event.currentTarget) markUserScrollIntent();
    },
    [markUserScrollIntent]
  );

  // A scrollTop assignment made before the scroller's first paint does NOT fire a scroll event, so
  // a virtualizer would keep windowing around its stale offset forever — it only learns scroll
  // positions from events. Dispatching one by hand is safe: the handler reads the element's real
  // scrollTop, so a duplicate event is a no-op.
  const setScrollTopNow = useCallback((scroller: HTMLDivElement, top: number) => {
    scroller.scrollTop = top;
    lastScrollTopRef.current = scroller.scrollTop;
    scroller.dispatchEvent(new Event('scroll'));
  }, []);

  // Deliberately a plain DOM scroll rather than a virtualizer's own scroll-to-end: that starts its
  // scroll-target reconciliation, and repeating it every frame while rows measure makes the two
  // loops fight and the viewport jitter. The element's own bottom is exact anyway, footer included.
  const scrollToBottomNow = useCallback(
    (behavior: 'auto' | 'smooth') => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const top = scrollBoundaryTop(scroller, 'bottom');
      if (behavior === 'auto' && Math.abs(scroller.scrollTop - top) < 0.5) return;
      markSelfScroll(behavior, top);
      if (behavior === 'smooth') {
        scroller.scrollTo({ behavior: 'smooth', top });
        return;
      }
      setScrollTopNow(scroller, top);
    },
    [markSelfScroll, scrollerRef, setScrollTopNow]
  );

  // One landing only reaches the bottom the list knows about. Rows still carrying their estimate
  // grow as they mount and measure, pushing the real bottom further down, so the landing repeats
  // until the position holds — or until the user scrolls and takes over. rAF-paced while visible;
  // a hidden document FREEZES rAF entirely (a chat opened in a background tab), so ticks fall back
  // to a timer there — layout still updates while hidden, and the tab must already sit on the
  // bottom when the user switches to it.
  const settleAtBottom = useCallback(() => {
    let cancel: (() => void) | undefined;
    let stableFrames = 0;
    const deadline = performance.now() + BOTTOM_SETTLE_MS;
    const schedule = (callback: () => void) => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        const timer = window.setTimeout(callback, HIDDEN_SETTLE_INTERVAL_MS);
        cancel = () => window.clearTimeout(timer);
        return;
      }
      const raf = requestAnimationFrame(callback);
      cancel = () => cancelAnimationFrame(raf);
    };
    const tick = () => {
      const scroller = scrollerRef.current;
      if (!scroller || userScrolledRef.current || !pinnedRef.current) return;
      const atExactBottom = isAtBottom(scroller, TRUE_BOTTOM_THRESHOLD);
      if (!atExactBottom) scrollToBottomNow('auto');
      const next = reduceSettleStability(stableFrames, atExactBottom);
      stableFrames = next.stableFrames;
      if (next.settled || performance.now() >= deadline) return;
      schedule(tick);
    };
    schedule(tick);
    return () => cancel?.();
  }, [scrollToBottomNow, scrollerRef]);

  const evaluateEdges = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const atStartEdge = scroller.scrollTop <= EDGE_THRESHOLD;
    if (shouldFireEdge(atStartEdge, startArmedRef.current)) onStartReached?.();
    startArmedRef.current = !atStartEdge;

    const atEndEdge = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= EDGE_THRESHOLD;
    if (shouldFireEdge(atEndEdge, endArmedRef.current)) onEndReached?.();
    endArmedRef.current = !atEndEdge;
  }, [onEndReached, onStartReached, scrollerRef]);

  // Callers re-arm when the row set changed at an edge. Leaving the zone is not enough on its own:
  // a page of older rows shorter than the zone would leave the reader inside it with the callback
  // disarmed, and no further scroll event could ever resume paging.
  const armEdges = useCallback(() => {
    startArmedRef.current = true;
    endArmedRef.current = true;
  }, []);

  const publishAtBottom = useCallback(
    (atBottom: boolean) => {
      if (publishedAtBottomRef.current === atBottom) return;
      publishedAtBottomRef.current = atBottom;
      onAtBottomChange?.(atBottom);
    },
    [onAtBottomChange]
  );

  const handleScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const previousTop = lastScrollTopRef.current;
    const scrollTop = scroller.scrollTop;
    const direction =
      previousTop === null ? 'none' : scrollTop < previousTop ? 'up' : scrollTop > previousTop ? 'down' : 'none';
    lastScrollTopRef.current = scrollTop;

    const now = performance.now();
    const scrollHeight = scroller.scrollHeight;
    const previousHeight = lastScrollHeightRef.current;
    lastScrollHeightRef.current = scrollHeight;

    const selfScroll =
      consumeSelfTarget(selfTargetsRef.current, scrollTop, now, scrollHeight - scroller.clientHeight) ||
      now <= selfScrollUntilRef.current;
    const notTheReader =
      selfScroll ||
      isLayoutInducedScroll(
        now <= userIntentUntilRef.current,
        previousHeight !== null && previousHeight !== scrollHeight
      );
    if (!notTheReader && direction !== 'none') userScrolledRef.current = true;
    const atBottom = isAtBottom(scroller);
    const next = reducePinnedOnScroll(pinnedRef.current, notTheReader, atBottom, direction);
    pinnedRef.current = next.pinned;
    if (next.selfScrollConsumed && atBottom) selfScrollUntilRef.current = 0;
    // Returning to the bottom hands following back to the list.
    if (next.pinned) userScrolledRef.current = false;

    if (shouldPublishAtBottomChange(atBottom, pinnedRef.current, userScrolledRef.current)) {
      publishAtBottom(atBottom);
    }

    evaluateEdges();
  }, [evaluateEdges, publishAtBottom, scrollerRef]);

  const scrollToTop = useCallback(
    (behavior: 'auto' | 'smooth') => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      pinnedRef.current = false;
      userScrolledRef.current = true;
      markSelfScroll(behavior, 0);
      scroller.scrollTo({ behavior, top: scrollBoundaryTop(scroller, 'top') });
    },
    [markSelfScroll, scrollerRef]
  );

  /** Hand control to the reader: stop following without moving the viewport. */
  const releaseToUser = useCallback(() => {
    pinnedRef.current = false;
    userScrolledRef.current = true;
  }, []);

  // Becoming visible again re-lands the bottom: while hidden, ResizeObserver delivery and rAF are
  // frozen or unreliable, so growth that happened in a background tab may have left the viewport
  // above the bottom even though the user never scrolled.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    let cancelSettle: (() => void) | undefined;
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (shouldPinToBottom(stickToBottom, pinnedRef.current) && !userScrolledRef.current) {
        cancelSettle = settleAtBottom();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      cancelSettle?.();
    };
  }, [settleAtBottom, stickToBottom]);

  // The viewport itself resizing (a growing composer, a window resize) moves the bottom without
  // any row changing — a virtualizer's row anchoring does not cover that case.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (shouldPinToBottom(stickToBottom, pinnedRef.current)) scrollToBottomNow('auto');
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scrollToBottomNow, scrollerRef, stickToBottom]);

  return {
    armEdges,
    evaluateEdges,
    handleKeyDown,
    handlePointerDown,
    handleScroll,
    markSelfScroll,
    markUserScrollIntent,
    pinnedRef,
    releaseToUser,
    scrollToBottomNow,
    scrollToTop,
    settleAtBottom,
    userScrolledRef
  };
}
