import type { CSSProperties, ReactNode, Ref } from 'react';

import { elementScroll, useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import { useCallback, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';

export interface VirtualListHandle {
  /** Jump to the physical top of the currently loaded rows. */
  scrollToTop: (behavior?: ScrollBehavior) => void;
  /** Jump to the latest row (and re-arm bottom-following). */
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  /** Scroll a specific item into view by its key (e.g. a mentioned/searched message). */
  scrollToKey: (key: string, opts?: { align?: 'start' | 'center' | 'end'; behavior?: 'auto' | 'smooth' }) => void;
}

export interface VirtualListProps<T> {
  items: T[];
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  /** Extra px rendered beyond the viewport so fast scrolls stay filled. */
  overscan?: number;
  /**
   * Height to assume for a row that has never been measured. The window is chosen from these
   * estimates, so a list whose rows run far taller than the default only mounts them once they
   * are already at the viewport edge — and the correction that follows their real measurement
   * lands in view, dragging the passage being read. Supply a per-item guess when row heights vary
   * by more than a factor of a few.
   */
  estimateRowHeight?: (item: T, index: number) => number;
  /**
   * Keep closing the gap to the bottom until the list has reached it once. A transcript that must
   * open at its newest message needs this: the first layout is built from estimates, and
   * correcting them can leave the viewport a screen short of the end — a position that is
   * indistinguishable, after the fact, from one the reader chose. Lists that may legitimately
   * open part-way through their content leave it off.
   */
  settleAtBottomOnLoad?: boolean;
  /** Follow new/growing content while the user is parked at the bottom (chat behaviour). */
  stickToBottom?: boolean;
  /** Rendered after the rows, inside the scroll area (e.g. a typing indicator). */
  footer?: ReactNode;
  /** Rendered before the rows, inside the scroll area. */
  header?: ReactNode;
  /** Anchored to the scroll viewport without contributing to the scrollable content height. */
  viewportOverlay?: ReactNode;
  /** Imperative control (scrollToTop/scrollToBottom/scrollToKey). */
  controlRef?: Ref<VirtualListHandle>;
  /** Fired when the viewport crosses into/out of the bottom — drive a "jump to latest" affordance. */
  onAtBottomChange?: (atBottom: boolean) => void;
  /** Fired when the user scrolls near the top — load older rows here. Return false when no load started. */
  onStartReached?: () => unknown;
  /** Fired when the user scrolls near the bottom — load newer rows here (history-mode paging). */
  onEndReached?: () => unknown;
  /** Fired when the virtualized viewport range changes. */
  onRangeChange?: (range: { endIndex: number; startIndex: number }) => void;
  /** ARIA role for the scroll region (e.g. "log" for a chat transcript). */
  role?: string;
  /** ARIA live politeness for the scroll region. */
  ariaLive?: 'off' | 'polite' | 'assertive';
  className?: string;
  style?: CSSProperties;
}

/** Assumed row height until at least one row has been measured. */
const ESTIMATED_ROW_HEIGHT = 96;
const START_REACHED_THRESHOLD = 240;
const START_REARM_THRESHOLD = START_REACHED_THRESHOLD + ESTIMATED_ROW_HEIGHT;
const END_REACHED_THRESHOLD = 240;
const AT_END_THRESHOLD = 32;
// Minimum upward scrollTop delta on a scroll event that counts as the reader taking over. Above
// macOS momentum rubber-band jitter, below any deliberate drag.
const UP_SCROLL_INTENT_EPSILON = 8;
// Core's pinned-to-end window for streaming growth (official chat guidance: ~80px). Wider than
// AT_END_THRESHOLD so a momentary frame of lag can't drop the viewport out of the pinned path,
// while the jump-to-latest affordance still uses the tighter visual threshold.
const SCROLL_END_THRESHOLD = 80;
// Small enough that any deliberate scroll up stops native append-following at once (the library
// checks isAtEnd against this), yet above zero to absorb sub-pixel rounding.
const NATIVE_SCROLL_END_THRESHOLD = 2;
// How long a list that opens at its newest content keeps closing the gap on its own. Long enough
// to cover data that lands after the first layout, short enough that a reader who takes over is
// never fought for more than a moment.
const SETTLE_WINDOW_MS = 3000;
const ROW_STYLE_BASE: CSSProperties = {
  boxSizing: 'border-box',
  left: 0,
  minWidth: 0,
  position: 'absolute',
  top: 0,
  width: '100%'
};

type VirtualizerBoundaryState = {
  getDistanceFromEnd: () => number;
  getTotalSize: () => number;
  isAtEnd: (threshold?: number) => boolean;
  range: { endIndex: number; startIndex: number } | null;
  scrollOffset: number | null;
};

type ScrollBoundaryMetrics = {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
};

/** Position of the item with `key`, or -1. Used by the scrollToKey handle. */
export function indexOfKey<T>(items: T[], getKey: (item: T) => string, key: string): number {
  return items.findIndex((item) => getKey(item) === key);
}

/** Props express overscan in px; the virtualizer counts rows. */
export function overscanRowCount(overscanPx: number, estimatedRowHeight = ESTIMATED_ROW_HEIGHT): number {
  return Math.max(1, Math.ceil(overscanPx / estimatedRowHeight));
}

/**
 * Generic windowed list over @tanstack/react-virtual.
 *
 * TanStack Virtual owns dynamic measurement, prepend anchoring, append following, and imperative
 * scrolling. This component only adds product callbacks for entering the loaded start/end zones.
 */
export function VirtualList<T>({
  items,
  getKey,
  renderItem,
  overscan = 400,
  estimateRowHeight,
  settleAtBottomOnLoad = false,
  stickToBottom = false,
  footer,
  header,
  viewportOverlay,
  controlRef,
  onAtBottomChange,
  onStartReached,
  onEndReached,
  onRangeChange,
  role,
  ariaLive,
  className,
  style
}: VirtualListProps<T>): React.ReactElement {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  // Header content sits above the rows in normal flow, so every item start must be offset by its
  // height (the virtualizer's `scrollMargin`).
  const [headerHeight, setHeaderHeight] = useState(0);
  // Rows must not mount before the virtualizer has adopted the scroll element: its ResizeObserver
  // only exists once that happens, and a row whose ref runs earlier is cached as observed while
  // never actually being watched — its later growth (a streaming message) would go unmeasured.
  const [scrollerReady, setScrollerReady] = useState(false);

  const lastRangeRef = useRef<{ endIndex: number; startIndex: number } | null>(null);
  const lastAtEndRef = useRef<boolean | null>(null);
  const lastTotalSizeRef = useRef<number | null>(null);
  const startArmedRef = useRef(!stickToBottom);
  const endArmedRef = useRef(true);
  const initialEndScrollDoneRef = useRef(!stickToBottom);
  const reachedBottomOnceRef = useRef(!settleAtBottomOnLoad);
  // A real scroll away from the live edge ends the opening convergence: from then on the reader
  // owns the position, and an unbounded pin would fight them.
  const leftBottomRef = useRef(false);
  // Tracks the last scrollTop seen on a real scroll event, to tell a reader's upward scroll from
  // the pin's own downward correction (see the onScroll handler).
  const previousScrollTopRef = useRef<number | null>(null);
  const wasAtEndRef = useRef(true);
  const mountedAtRef = useRef(performance.now());
  const previousLastKeyRef = useRef<string | null>(null);
  const latestRef = useRef({
    estimateRowHeight,
    getKey,
    items,
    onAtBottomChange,
    onEndReached,
    onRangeChange,
    onStartReached
  });
  latestRef.current = {
    estimateRowHeight,
    getKey,
    items,
    onAtBottomChange,
    onEndReached,
    onRangeChange,
    onStartReached
  };

  const hasFooter = footer !== undefined && footer !== null;
  const lastItem = items.at(-1);
  const lastItemKey = lastItem === undefined ? null : getKey(lastItem);
  const firstItem = items[0];
  const firstItemKey = firstItem === undefined ? null : getKey(firstItem);
  const previousFirstKeyRef = useRef<string | null>(null);

  const emitRange = useCallback((range: { endIndex: number; startIndex: number } | null) => {
    const publish = latestRef.current.onRangeChange;
    if (!publish || !range) return;
    const next = { endIndex: range.endIndex, startIndex: range.startIndex };
    const previous = lastRangeRef.current;
    if (previous && previous.startIndex === next.startIndex && previous.endIndex === next.endIndex) return;
    lastRangeRef.current = next;
    publish(next);
  }, []);

  const releaseEndFollow = useCallback(() => {
    leftBottomRef.current = true;
    wasAtEndRef.current = false;
    if (lastAtEndRef.current === false) return;
    lastAtEndRef.current = false;
    latestRef.current.onAtBottomChange?.(false);
  }, []);

  const evaluateBoundaries = useCallback(
    (instance: VirtualizerBoundaryState, metrics?: ScrollBoundaryMetrics) => {
      emitRange(instance.range);

      // Re-pin only when the content itself grew. Scrolling never changes the total size, so a
      // reader easing away from the bottom is not fought; a streamed token or a settling
      // measurement does change it, and with directDomUpdates that growth often skips React
      // entirely, so this notification is the only place left that still runs. Until the initial
      // end-scroll has settled the pin is unbounded — the first layout is built from estimates
      // and can be off by far more than the follow threshold.
      // The library follows APPENDS (followOnAppend, on count change), but a chat's last message
      // grows token by token WITHOUT changing the count — followOnAppend never fires, so the
      // viewport drifts a line off the bottom on every token. Re-pin that one case by hand: on any
      // growth while the previous frame sat at the live edge (same 2px threshold the library uses,
      // so the reader detaches identically), snap back to the end.
      const scroller = scrollerRef.current;
      const totalSize = instance.getTotalSize();
      const grew = totalSize !== lastTotalSizeRef.current;
      lastTotalSizeRef.current = totalSize;
      if (scroller && stickToBottom && grew) {
        const target = scroller.scrollHeight - scroller.clientHeight;
        const distance = target - scroller.scrollTop;
        // First-layout settle: a list that must open at the bottom starts from estimates and can
        // land a screen short with no append to trigger followOnAppend. Close that gap until it
        // touches bottom once, bounded by a short window and abandoned if the reader scrolls away.
        const settling =
          settleAtBottomOnLoad &&
          !reachedBottomOnceRef.current &&
          !leftBottomRef.current &&
          performance.now() - mountedAtRef.current < SETTLE_WINDOW_MS;
        if (distance <= 1) reachedBottomOnceRef.current = true;
        if (distance > 1 && (settling || wasAtEndRef.current)) scroller.scrollTop = target;
      }

      const knownScrollOffset = metrics?.scrollTop;
      if (knownScrollOffset !== null && knownScrollOffset !== undefined) {
        const scrollOffset = Math.max(knownScrollOffset, 0);
        const atStart = scrollOffset <= START_REACHED_THRESHOLD;
        if (!initialEndScrollDoneRef.current) {
          if (stickToBottom && atStart) return;
          initialEndScrollDoneRef.current = true;
        }
        if (atStart && startArmedRef.current && initialEndScrollDoneRef.current) {
          const handled = latestRef.current.onStartReached?.();
          if (handled !== false) startArmedRef.current = false;
        } else if (scrollOffset > START_REARM_THRESHOLD) {
          // Hysteresis: a prepended page first lands at its estimated height and is corrected once
          // the rows measure. That transient overshoot must not re-arm the start edge, or the
          // correction re-enters the zone and chains a second, unrequested page load.
          startArmedRef.current = true;
        }
      }

      const distanceFromEnd = metrics
        ? Math.max(metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight, 0)
        : instance.getDistanceFromEnd();
      const atEndEdge = distanceFromEnd <= END_REACHED_THRESHOLD;
      if (atEndEdge && endArmedRef.current) {
        const handled = latestRef.current.onEndReached?.();
        if (handled !== false) endArmedRef.current = false;
      } else if (!atEndEdge) {
        endArmedRef.current = true;
      }

      // The reader scrolling clear of the live edge abandons the opening settle.
      if (metrics && distanceFromEnd > SCROLL_END_THRESHOLD) leftBottomRef.current = true;
      // Record whether the viewport is at the end, read from the LIVE DOM so it reflects the pin
      // just applied above (the instance's cached offset lags a frame). Next growth reads this to
      // decide whether the reader was still following. Same tiny threshold the library uses, so
      // hand-pinned token-growth and library-pinned appends agree on when the reader took over.
      if (scroller) {
        wasAtEndRef.current =
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= NATIVE_SCROLL_END_THRESHOLD;
      }
      const atEnd = metrics ? distanceFromEnd <= AT_END_THRESHOLD : instance.isAtEnd(AT_END_THRESHOLD);
      if (lastAtEndRef.current !== atEnd) {
        lastAtEndRef.current = atEnd;
        latestRef.current.onAtBottomChange?.(atEnd);
      }
    },
    [emitRange, settleAtBottomOnLoad, stickToBottom]
  );

  // The footer key must be STABLE across appends: a key that embeds the last item's key remounts
  // the footer row on every append, dropping its measured size back to the estimate for a frame —
  // a visible bottom-edge blip on each streamed message.
  const keyOfIndex = useCallback((index: number): string => {
    const item = latestRef.current.items[index];
    return item === undefined ? 'virtual-list-footer' : latestRef.current.getKey(item);
  }, []);
  const handleVirtualizerChange = useCallback(
    (instance: VirtualizerBoundaryState) => evaluateBoundaries(instance),
    [evaluateBoundaries]
  );

  const shouldFollowCommittedAppend =
    scrollerReady &&
    stickToBottom &&
    lastItemKey !== null &&
    previousLastKeyRef.current !== lastItemKey &&
    lastAtEndRef.current !== false;

  // When the item edges change while the reader is away from the bottom — a live append landing
  // mid-history-read, or an older page prepending mid-gesture — this render's setOptions computes
  // the end-anchor as `newStart + (cachedOffset - oldStart)`, and a cached offset that lags the
  // real scrollTop by a frame of wheel velocity turns that into an absolute write that swallows
  // the in-flight gesture: on screen the content lurches and snaps back. Refresh the cache from
  // the DOM for exactly these cases. Never while following the bottom: there the cache
  // deliberately tracks the unclamped pin target ahead of sizer growth, and overwriting it stalls
  // the pin.
  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, Element> | null>(null);
  if (
    virtualizerRef.current &&
    scrollerRef.current &&
    virtualizerRef.current.scrollOffset !== null &&
    lastAtEndRef.current === false &&
    (lastItemKey !== previousLastKeyRef.current || firstItemKey !== previousFirstKeyRef.current)
  ) {
    virtualizerRef.current.scrollOffset = scrollerRef.current.scrollTop;
  }
  // An older page arriving ends the opening convergence too. By then the list is established and
  // the reader is at the far end of it; the unbounded pin exists only to finish the very first
  // layout, and letting it survive a prepend would drag them back from the history they just
  // asked for.
  if (previousFirstKeyRef.current !== null && firstItemKey !== previousFirstKeyRef.current) {
    leftBottomRef.current = true;
  }
  previousFirstKeyRef.current = firstItemKey;

  const virtualizer = useVirtualizer({
    anchorTo: stickToBottom ? 'end' : 'start',
    count: items.length + (hasFooter ? 1 : 0),
    // Row positions and the sizer height are written straight to the DOM on every virtualizer
    // notification, in the same synchronous batch as its scroll corrections. Routing positions
    // through React state instead lets a paint land between a multi-thousand-pixel correction
    // (tall message measuring far over its estimate) and the concurrent re-render that moves the
    // rows — one whole frame of blank viewport.
    directDomUpdates: true,
    estimateSize: (index) => {
      const item = latestRef.current.items[index];
      if (item === undefined) return ESTIMATED_ROW_HEIGHT;
      return latestRef.current.estimateRowHeight?.(item, index) ?? ESTIMATED_ROW_HEIGHT;
    },
    // The library's followOnAppend only fires on APPEND (count change) and, when on, perturbs the
    // end-anchor used for prepends. A single growth pin below handles append and token-growth
    // alike — gated on whether the previous frame sat within the same 2px window the library would
    // use — so following is uniform and prepend anchoring is left untouched.
    followOnAppend: false,
    getItemKey: keyOfIndex,
    getScrollElement: () => scrollerRef.current,
    onChange: handleVirtualizerChange,
    overscan: overscanRowCount(overscan),
    scrollEndThreshold: NATIVE_SCROLL_END_THRESHOLD,
    scrollMargin: headerHeight,
    // Measurement corrections arrive as absolute writes rebased on the instance's cached offset;
    // mid-gesture that base lags the real scrollTop by a frame of wheel velocity, so each write
    // erases the input applied since — with tall messages measuring thousands of pixels over
    // their estimate, that is the judder on every page load while scrolling. The adjustment is a
    // pure delta, so apply it relatively when the reader is AWAY from the end. Near the end keep
    // the library's absolute path: the bottom pin intentionally targets beyond the current
    // scrollHeight while the sizer catches up, and a relative write clamps that away (stalled the
    // pin at ~350px off in an earlier attempt).
    scrollToFn: (offset, { adjustments, behavior }, instance) => {
      const el = instance.scrollElement;
      if (!el) return;
      if (adjustments !== undefined && behavior !== 'smooth') {
        const distanceFromEnd = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distanceFromEnd > SCROLL_END_THRESHOLD * 2) {
          el.scrollBy({ behavior: 'instant', top: adjustments });
          return;
        }
      }
      elementScroll(offset, { adjustments, behavior }, instance);
    }
  });
  virtualizerRef.current = virtualizer;
  // Core's default predicate plus one extra rule: a row-0 resize while the reader holds the
  // loaded top must still anchor the prepend boundary (dragging the scrollbar to the exact top
  // leaves scrollOffset at 0, where the default sees nothing above the viewport to compensate).
  // The default's offset term includes the adjustments already applied during the current measure
  // batch; omitting it misclassifies rows when a prepended page measures several rows in one
  // sweep, and each miss is a visible jump. `scrollAdjustments` is private in the typings — the
  // cast is the price of mirroring the default exactly.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, delta, instance) => {
    // While the reader is glued to the end, ANY resize must shift the offset by its delta to keep
    // the bottom pinned. The library's own wasAtEnd path intends exactly this but reads its cached
    // scrollOffset, which lags one frame behind a scrollTop written earlier in this same commit
    // (scroll events deliver next frame) — so a measure landing right after an append is
    // misjudged. The live DOM distance cannot lag.
    if (stickToBottom) {
      const scroller = scrollerRef.current;
      if (scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= SCROLL_END_THRESHOLD) {
        return true;
      }
    }
    // Judge above/below against the LIVE scrollTop, not the instance's cached offset: mid-gesture
    // the cache lags by a frame of scroll velocity, and every row inside that stale band gets
    // classified on the wrong side of the viewport — each miss leaks an uncompensated shift.
    // (item.start is directly comparable: rows are laid out at translateY(start - scrollMargin)
    // inside the sizer that itself sits below the scrollMargin-tall header.) The DOM read also
    // already reflects any adjustment applied earlier in this same measure batch, which the
    // cached-offset path had to reconstruct from the private `scrollAdjustments` field.
    const liveScroller = scrollerRef.current;
    const scrollOffset =
      liveScroller?.scrollTop ??
      (instance.scrollOffset ?? 0) + (instance as unknown as { scrollAdjustments: number }).scrollAdjustments;
    if (item.index === 0 && scrollOffset <= START_REACHED_THRESHOLD) return true;
    if (item.start >= scrollOffset) return false;
    if (!instance.itemSizeCache.has(item.key) || instance.scrollDirection !== 'backward') return true;
    // A mounted above-viewport row re-measuring during backward scroll is real content reflow
    // (late syntax highlight, image dimensions, font swap) — core's cascade guard skips it, so
    // everything below visibly shifts by the delta on every pass. Compensate here with a RELATIVE
    // scrollBy: unlike core's absolute write from its frame-stale cached offset, it cannot swallow
    // the wheel delta already in flight.
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollBy({ top: delta });
    return false;
  };

  const virtualItems = virtualizer.getVirtualItems();

  useLayoutEffect(() => {
    setScrollerReady(true);
  }, []);

  useLayoutEffect(() => {
    const headerNode = headerRef.current;
    if (!headerNode) return;
    setHeaderHeight((height) => (height === headerNode.offsetHeight ? height : headerNode.offsetHeight));
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      setHeaderHeight((height) => (height === headerNode.offsetHeight ? height : headerNode.offsetHeight));
    });
    observer.observe(headerNode);
    return () => observer.disconnect();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, when the rows first mount
  useLayoutEffect(() => {
    if (!scrollerReady) return;
    if (stickToBottom && items.length > 0) virtualizer.scrollToEnd();
  }, [scrollerReady]);

  useLayoutEffect(() => {
    previousLastKeyRef.current = lastItemKey;
    // followOnAppend may evaluate before React commits the new total height. Repeat the library's
    // end scroll after that commit only when the previous viewport was still pinned to the end.
    if (shouldFollowCommittedAppend) virtualizer.scrollToEnd();
  }, [lastItemKey, shouldFollowCommittedAppend, virtualizer]);

  useLayoutEffect(() => {
    if (!scrollerReady) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    // directDomUpdates positions rows on virtualizer notifications, but a row remounting with an
    // unchanged cached size emits none (its measure delta is zero) — without this commit-time
    // pass it would paint at the shared top:0 anchor, stacked over the first row.
    for (const virtualRow of virtualizer.getVirtualItems()) {
      const rowElement = virtualizer.elementsCache.get(virtualRow.key) as HTMLElement | undefined;
      if (rowElement) rowElement.style.transform = `translate3d(0, ${virtualRow.start - headerHeight}px, 0)`;
    }
    // Re-pin against DOM truth while following. The virtualizer's own end-keeping works in virtual
    // coordinates and its scroll-reconcile can land on a measurement taken before the commit that
    // just grew a row, leaving the viewport parked a line-height off the bottom until the next
    // append — which the reader sees as per-token bouncing. scrollHeight after commit is the one
    // number that cannot disagree with what is about to paint.
    if (stickToBottom && lastAtEndRef.current !== false && initialEndScrollDoneRef.current) {
      // The live-distance bound matters as much as the follow gate: a fast fling away from the
      // bottom can commit before the scroll event that clears the gate, and an unbounded pin
      // would yank the reader straight back to the end.
      const pin = () => {
        const target = scroller.scrollHeight - scroller.clientHeight;
        const distance = target - scroller.scrollTop;
        if (distance > 1 && distance <= SCROLL_END_THRESHOLD) scroller.scrollTop = target;
      };
      pin();
      // The pin above reads geometry mid-commit; a measurement-driven follow-up render inside the
      // same task can move the end again after this effect ran. A microtask still lands before
      // paint, so the re-pin is never visible as a bounce.
      queueMicrotask(() => {
        if (lastAtEndRef.current !== false) pin();
      });
    }
    evaluateBoundaries(virtualizer, {
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
      scrollTop: scroller.scrollTop
    });
  });

  useImperativeHandle(
    controlRef,
    () => ({
      scrollToTop: (behavior = 'auto') => {
        initialEndScrollDoneRef.current = true;
        startArmedRef.current = true;
        // Drop the follow gate before moving: the commit-time re-pin reads it, and the scroll
        // event that would clear it only lands next frame — leaving it set yanks the viewport
        // straight back to the bottom.
        lastAtEndRef.current = false;
        leftBottomRef.current = true;
        wasAtEndRef.current = false;
        latestRef.current.onAtBottomChange?.(false);
        virtualizer.scrollToOffset(0, { behavior });
        requestAnimationFrame(() => {
          const scroller = scrollerRef.current;
          evaluateBoundaries(
            virtualizer,
            scroller
              ? {
                  clientHeight: scroller.clientHeight,
                  scrollHeight: scroller.scrollHeight,
                  scrollTop: scroller.scrollTop
                }
              : undefined
          );
        });
      },
      scrollToBottom: (behavior = 'auto') => {
        virtualizer.scrollToEnd({ behavior });
      },
      scrollToKey: (key, opts) => {
        const index = indexOfKey(latestRef.current.items, latestRef.current.getKey, key);
        if (index < 0) return;
        if (index < latestRef.current.items.length - 1) {
          lastAtEndRef.current = false;
          leftBottomRef.current = true;
          wasAtEndRef.current = false;
          latestRef.current.onAtBottomChange?.(false);
        }
        virtualizer.scrollToIndex(index, { align: opts?.align ?? 'center', behavior: opts?.behavior });
      }
    }),
    [evaluateBoundaries, virtualizer]
  );

  return (
    <div
      aria-live={ariaLive}
      className={className}
      onScroll={(event) => {
        // A scrollbar drag or keyboard scroll toward the top is the reader taking over, exactly
        // like the wheel/touch handlers below, but it emits no wheel or touch event — only this
        // scroll event. During the opening convergence leftBottomRef is otherwise cleared solely
        // by those handlers, so a scrollbar drag up would leave the unbounded pin free to yank the
        // reader back on the next growth tick. The pin only ever moves the offset down toward the
        // bottom and a measurement reflow emits no scroll event, so a scrollTop that decreased past
        // the momentum-jitter epsilon is unambiguously the reader scrolling up.
        const scrollTop = event.currentTarget.scrollTop;
        const previous = previousScrollTopRef.current;
        previousScrollTopRef.current = scrollTop;
        if (previous !== null && scrollTop < previous - UP_SCROLL_INTENT_EPSILON) releaseEndFollow();
        evaluateBoundaries(virtualizer, {
          clientHeight: event.currentTarget.clientHeight,
          scrollHeight: event.currentTarget.scrollHeight,
          scrollTop
        });
      }}
      onTouchMove={() => {
        // A touch drag is the reader driving the viewport directly; releasing the pin here lets a
        // drag toward the top hold, and a drag back to the bottom re-arms following through the
        // usual at-end detection.
        releaseEndFollow();
      }}
      onWheel={(event) => {
        // A wheel or trackpad gesture toward the top is the reader taking over, and it is the one
        // detach signal that content growth cannot forge: while a message streams, appends keep
        // the viewport's distance-from-bottom small no matter how far up the reader nudged, so a
        // distance-gated detach never fires and the pin drags them back on the next token. The
        // gesture is direct proof of intent, independent of where the scroll position lands.
        if (event.deltaY < 0) releaseEndFollow();
      }}
      ref={scrollerRef}
      role={role}
      style={{ height: '100%', overflowAnchor: 'none', overflowY: 'auto', ...style }}
    >
      <div ref={headerRef}>{header}</div>
      {/* directDomUpdates owns the sizer height and each row's transform; React must not write
          either (the doubled writes race). Rows hand their node straight to measureElement: it
          measures synchronously at commit (pre-paint) and its internal ResizeObserver tracks
          later growth. A row remounting with an unchanged cached size produces no notification,
          so the commit-time effect below re-applies positions to cover it. */}
      <div
        ref={virtualizer.containerRef}
        style={{ position: 'relative', width: '100%' }}
      >
        {scrollerReady &&
          virtualItems.map((virtualRow) => {
            const item = items[virtualRow.index];
            const content = item === undefined && hasFooter ? footer : item === undefined ? null : renderItem(item);
            if (content === null) return null;
            return (
              <div
                data-index={virtualRow.index}
                data-vl-key={String(virtualRow.key)}
                key={virtualRow.key}
                ref={virtualizer.measureElement}
                style={ROW_STYLE_BASE}
              >
                {content}
              </div>
            );
          })}
      </div>
      {viewportOverlay ? (
        <div style={{ bottom: 0, height: 0, position: 'sticky', zIndex: 1 }}>
          <div style={{ bottom: 0, left: 0, position: 'absolute', right: 0 }}>{viewportOverlay}</div>
        </div>
      ) : null}
    </div>
  );
}
