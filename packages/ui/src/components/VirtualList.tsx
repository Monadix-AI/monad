import type { CSSProperties, ReactNode, Ref } from 'react';

import { elementScroll, useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';

import {
  HIDDEN_SETTLE_INTERVAL_MS,
  STICK_THRESHOLD,
  shouldPinToBottom,
  useBottomFollow
} from '../hooks/use-bottom-follow';

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
  /** Follow new/growing content while the user is parked at the bottom (chat behaviour). */
  stickToBottom?: boolean;
  /** Rendered after the rows, inside the scroll area (e.g. a typing indicator). */
  footer?: ReactNode;
  /** Rendered before the rows, inside the scroll area. */
  header?: ReactNode;
  /** Imperative control (scrollToTop/scrollToBottom/scrollToKey). */
  controlRef?: Ref<VirtualListHandle>;
  /** Fired when the viewport crosses into/out of the bottom — drive a "jump to latest" affordance. */
  onAtBottomChange?: (atBottom: boolean) => void;
  /** Fired when the user scrolls near the top — load older rows here. */
  onStartReached?: () => void;
  /** Fired when the user scrolls near the bottom — load newer rows here (history-mode paging). */
  onEndReached?: () => void;
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

const ROW_STYLE_BASE: CSSProperties = {
  boxSizing: 'border-box',
  left: 0,
  minWidth: 0,
  position: 'absolute',
  top: 0,
  width: '100%'
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
 * Average measured row height, used to estimate rows not yet measured. A fixed guess is off by an
 * order of magnitude on real chat rows (~100px vs ~1800px), which mis-sizes the total scroll
 * height — the scrollbar visibly re-scales as rows measure in.
 */
export function averageMeasuredRowHeight(sizes: Iterable<number>, fallback = ESTIMATED_ROW_HEIGHT): number {
  let sum = 0;
  let count = 0;
  for (const size of sizes) {
    sum += size;
    count += 1;
  }
  return count === 0 ? fallback : Math.max(1, Math.round(sum / count));
}

/** The row set changed at an edge when the first or last key differs from the previous render. */
export function edgeKeysOf<T>(
  items: T[],
  getKey: (item: T) => string
): { firstKey: string | null; lastKey: string | null } {
  const first = items[0];
  const last = items.at(-1);
  return {
    firstKey: first === undefined ? null : getKey(first),
    lastKey: last === undefined ? null : getKey(last)
  };
}

/**
 * Generic windowed list over @tanstack/react-virtual.
 *
 * Rows measure themselves (`measureElement` observes every mounted row), so a message growing IN
 * PLACE while it streams reflows without any item-count change. Holding the viewport steady
 * through that growth is the library's job (`anchorTo`/`followOnAppend`); whether the READER still
 * wants to sit at the bottom is `useBottomFollow`'s.
 */
export function VirtualList<T>({
  items,
  getKey,
  renderItem,
  overscan = 400,
  stickToBottom = false,
  footer,
  header,
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
  const footerRef = useRef<HTMLDivElement>(null);
  // Header content sits above the rows in normal flow, so every item start must be offset by its
  // height (the virtualizer's `scrollMargin`).
  const [headerHeight, setHeaderHeight] = useState(0);
  // Rows must not mount before the virtualizer has adopted the scroll element: its ResizeObserver
  // only exists once that happens, and a row whose ref runs earlier is cached as observed while
  // never actually being watched — its later growth (a streaming message) would go unmeasured.
  const [scrollerReady, setScrollerReady] = useState(false);

  const follow = useBottomFollow({ onAtBottomChange, onEndReached, onStartReached, scrollerRef, stickToBottom });
  const { armEdges, evaluateEdges, markSelfScroll, pinnedRef, scrollToBottomNow, settleAtBottom } = follow;

  const lastRangeRef = useRef<{ endIndex: number; startIndex: number } | null>(null);
  const latestRef = useRef({ getKey, items, onRangeChange });
  latestRef.current = { getKey, items, onRangeChange };

  const emitRange = useCallback((range: { endIndex: number; startIndex: number } | null) => {
    const publish = latestRef.current.onRangeChange;
    if (!publish || !range) return;
    const next = { endIndex: range.endIndex, startIndex: range.startIndex };
    const previous = lastRangeRef.current;
    if (previous && previous.startIndex === next.startIndex && previous.endIndex === next.endIndex) return;
    lastRangeRef.current = next;
    publish(next);
  }, []);

  // Estimate = running average of the rows measured so far. Updated outside React state on
  // purpose: the value only matters the next time measurements recompute (a count change re-runs
  // `estimateSize` for every unmeasured row), so re-rendering for it would be pure churn.
  const estimatedRowHeightRef = useRef(ESTIMATED_ROW_HEIGHT);
  const measuredRowCountRef = useRef(0);

  const virtualizer = useVirtualizer({
    // `anchorTo: 'end'` keeps the viewport still when the row set changes at either edge (older
    // history prepended, a row settling from its estimate) and re-pins the bottom when a row grows
    // IN PLACE while streaming; `followOnAppend` follows newly appended rows, but only for a user
    // who is already parked within `scrollEndThreshold` of the bottom.
    anchorTo: stickToBottom ? 'end' : 'start',
    count: items.length,
    estimateSize: () => estimatedRowHeightRef.current,
    followOnAppend: stickToBottom ? 'auto' : false,
    getItemKey: (index) => {
      const item = latestRef.current.items[index];
      return item === undefined ? index : latestRef.current.getKey(item);
    },
    getScrollElement: () => scrollerRef.current,
    onChange: (instance) => {
      if (instance.itemSizeCache.size !== measuredRowCountRef.current) {
        measuredRowCountRef.current = instance.itemSizeCache.size;
        estimatedRowHeightRef.current = averageMeasuredRowHeight(instance.itemSizeCache.values());
      }
      emitRange(instance.range);
    },
    // Scroll-only updates write row transforms and the container size straight to the DOM and
    // skip the React re-render; React still re-renders when the visible range changes.
    directDomUpdates: true,
    overscan: overscanRowCount(overscan, estimatedRowHeightRef.current),
    scrollEndThreshold: STICK_THRESHOLD,
    scrollMargin: headerHeight,
    // Every library-driven scroll — anchor corrections while rows measure, follow-on-append,
    // scrollToIndex — funnels through here. Flag it BEFORE it fires so the scroll handler never
    // reads a correction as the user scrolling away (which would silently cancel following).
    scrollToFn: (offset, scrollOptions, instance) => {
      markSelfScroll(
        scrollOptions.behavior === 'smooth' ? 'smooth' : 'auto',
        offset + (scrollOptions.adjustments ?? 0)
      );
      elementScroll(offset, scrollOptions, instance);
    }
  });

  const totalSize = virtualizer.getTotalSize();
  const virtualItems = virtualizer.getVirtualItems();

  useLayoutEffect(() => {
    setScrollerReady(true);
  }, []);

  // Header and footer sit outside the virtualized rows, so neither the total row height nor the
  // library's anchoring notices when they resize — yet both move the bottom.
  useLayoutEffect(() => {
    const headerNode = headerRef.current;
    const footerNode = footerRef.current;
    if (!headerNode || !footerNode || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      setHeaderHeight(headerNode.offsetHeight);
      if (shouldPinToBottom(stickToBottom, pinnedRef.current)) scrollToBottomNow('auto');
    });
    observer.observe(headerNode);
    observer.observe(footerNode);
    return () => observer.disconnect();
  }, [pinnedRef, scrollToBottomNow, stickToBottom]);

  // Land on the bottom as soon as the first rows exist.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, when the rows first mount
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !scrollerReady) return;
    let cancelSettle: (() => void) | undefined;
    if (stickToBottom && items.length > 0) {
      scrollToBottomNow('auto');
      cancelSettle = settleAtBottom();
    }
    // A list too short to scroll never emits a scroll event, so its edges are evaluated once the
    // initial position has settled — otherwise reverse pagination could never start. Edges only:
    // running the full scroll handler here would read a still-measuring list as "not at the
    // bottom" and cancel following before the first paint. Timer, not rAF: rAF never fires while
    // the document is hidden.
    const timer = window.setTimeout(evaluateEdges, HIDDEN_SETTLE_INTERVAL_MS);
    return () => {
      cancelSettle?.();
      window.clearTimeout(timer);
    };
  }, [scrollerReady]);

  // A page of older (or newer) rows re-arms its edge and is evaluated once: the reader may still
  // be inside the zone, and if that page was shorter than the zone no scroll event would follow to
  // continue paging.
  const { firstKey, lastKey } = edgeKeysOf(items, getKey);
  // biome-ignore lint/correctness/useExhaustiveDependencies: edge keys are the trigger, not a read
  useLayoutEffect(() => {
    if (!scrollerReady) return;
    armEdges();
    evaluateEdges();
  }, [armEdges, evaluateEdges, firstKey, lastKey, scrollerReady]);

  // Re-pin after a React commit that changed the measured height (rows added or removed, a new
  // range measured). In-place growth of an existing row is NOT covered here — `directDomUpdates`
  // skips the commit for it — and does not need to be: the virtualizer's own end-anchoring keeps
  // the viewport on the bottom through it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: totalSize is the trigger, not a read
  useLayoutEffect(() => {
    if (!shouldPinToBottom(stickToBottom, pinnedRef.current)) return;
    return settleAtBottom();
  }, [pinnedRef, settleAtBottom, stickToBottom, totalSize]);

  useImperativeHandle(
    controlRef,
    () => ({
      scrollToTop: (behavior = 'auto') => follow.scrollToTop(behavior === 'smooth' ? 'smooth' : 'auto'),
      scrollToBottom: (behavior = 'auto') => {
        pinnedRef.current = true;
        follow.userScrolledRef.current = false;
        scrollToBottomNow(behavior === 'smooth' ? 'smooth' : 'auto');
      },
      scrollToKey: (key, opts) => {
        const index = indexOfKey(latestRef.current.items, latestRef.current.getKey, key);
        if (index < 0) return;
        follow.releaseToUser();
        markSelfScroll(opts?.behavior === 'smooth' ? 'smooth' : 'auto');
        virtualizer.scrollToIndex(index, { align: opts?.align ?? 'center', behavior: opts?.behavior });
      }
    }),
    [follow, markSelfScroll, pinnedRef, scrollToBottomNow, virtualizer]
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: scroll-intent detection on the scroll container
    <div
      aria-live={ariaLive}
      className={className}
      onKeyDown={follow.handleKeyDown}
      onPointerDown={follow.handlePointerDown}
      onScroll={follow.handleScroll}
      onTouchMove={follow.markUserScrollIntent}
      onWheel={follow.markUserScrollIntent}
      ref={scrollerRef}
      role={role}
      style={{ height: '100%', overflowAnchor: 'none', overflowY: 'auto', ...style }}
    >
      <div ref={headerRef}>{header}</div>
      {/* The virtualizer owns this container's height and each row's transform (directDomUpdates);
          setting either here would fight those direct writes. */}
      <div
        ref={virtualizer.containerRef}
        style={{ position: 'relative', width: '100%' }}
      >
        {scrollerReady &&
          virtualItems.map((virtualRow) => {
            const item = items[virtualRow.index];
            if (item === undefined) return null;
            return (
              <div
                data-index={virtualRow.index}
                key={virtualRow.key}
                ref={virtualizer.measureElement}
                style={ROW_STYLE_BASE}
              >
                {renderItem(item)}
              </div>
            );
          })}
      </div>
      <div ref={footerRef}>{footer}</div>
    </div>
  );
}
