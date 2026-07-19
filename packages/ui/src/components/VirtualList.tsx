import type { CSSProperties, ReactNode, Ref } from 'react';

import { useVirtualizer } from '@tanstack/react-virtual';
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
const START_REACHED_THRESHOLD = 240;
const END_REACHED_THRESHOLD = 240;
const AT_END_THRESHOLD = 32;
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
  // Header content sits above the rows in normal flow, so every item start must be offset by its
  // height (the virtualizer's `scrollMargin`).
  const [headerHeight, setHeaderHeight] = useState(0);
  // Rows must not mount before the virtualizer has adopted the scroll element: its ResizeObserver
  // only exists once that happens, and a row whose ref runs earlier is cached as observed while
  // never actually being watched — its later growth (a streaming message) would go unmeasured.
  const [scrollerReady, setScrollerReady] = useState(false);

  const lastRangeRef = useRef<{ endIndex: number; startIndex: number } | null>(null);
  const lastAtEndRef = useRef<boolean | null>(null);
  const startArmedRef = useRef(true);
  const endArmedRef = useRef(true);
  const previousLastKeyRef = useRef<string | null>(null);
  const latestRef = useRef({ getKey, items, onAtBottomChange, onEndReached, onRangeChange, onStartReached });
  latestRef.current = { getKey, items, onAtBottomChange, onEndReached, onRangeChange, onStartReached };

  const hasFooter = footer !== undefined && footer !== null;
  const lastItem = items.at(-1);
  const lastItemKey = lastItem === undefined ? null : getKey(lastItem);

  const emitRange = useCallback((range: { endIndex: number; startIndex: number } | null) => {
    const publish = latestRef.current.onRangeChange;
    if (!publish || !range) return;
    const next = { endIndex: range.endIndex, startIndex: range.startIndex };
    const previous = lastRangeRef.current;
    if (previous && previous.startIndex === next.startIndex && previous.endIndex === next.endIndex) return;
    lastRangeRef.current = next;
    publish(next);
  }, []);

  const evaluateBoundaries = useCallback(
    (instance: VirtualizerBoundaryState, metrics?: ScrollBoundaryMetrics) => {
      emitRange(instance.range);

      const scrollOffset = Math.max(metrics?.scrollTop ?? instance.scrollOffset ?? 0, 0);
      const atStart = scrollOffset <= START_REACHED_THRESHOLD;
      if (atStart && startArmedRef.current) {
        startArmedRef.current = false;
        latestRef.current.onStartReached?.();
      } else if (!atStart) {
        startArmedRef.current = true;
      }

      const distanceFromEnd = metrics
        ? Math.max(metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight, 0)
        : instance.getDistanceFromEnd();
      const atEndEdge = distanceFromEnd <= END_REACHED_THRESHOLD;
      if (atEndEdge && endArmedRef.current) {
        endArmedRef.current = false;
        latestRef.current.onEndReached?.();
      } else if (!atEndEdge) {
        endArmedRef.current = true;
      }

      const atEnd = instance.isAtEnd(AT_END_THRESHOLD);
      if (lastAtEndRef.current !== atEnd) {
        lastAtEndRef.current = atEnd;
        latestRef.current.onAtBottomChange?.(atEnd);
      }
    },
    [emitRange]
  );

  const keyOfIndex = useCallback((index: number): string => {
    const item = latestRef.current.items[index];
    if (item !== undefined) return latestRef.current.getKey(item);
    const last = latestRef.current.items.at(-1);
    return `virtual-list-footer:${last === undefined ? 'empty' : latestRef.current.getKey(last)}`;
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

  const virtualizer = useVirtualizer({
    anchorTo: stickToBottom ? 'end' : 'start',
    count: items.length + (hasFooter ? 1 : 0),
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    followOnAppend: stickToBottom,
    getItemKey: keyOfIndex,
    getScrollElement: () => scrollerRef.current,
    onChange: handleVirtualizerChange,
    overscan: overscanRowCount(overscan),
    scrollEndThreshold: AT_END_THRESHOLD,
    scrollMargin: headerHeight
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    const scrollOffset = instance.scrollOffset ?? 0;
    if (item.index === 0 && scrollOffset <= START_REACHED_THRESHOLD) return true;
    return item.start < scrollOffset && instance.scrollDirection !== 'backward';
  };

  const totalSize = virtualizer.getTotalSize();
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

  useImperativeHandle(
    controlRef,
    () => ({
      scrollToTop: (behavior = 'auto') => {
        startArmedRef.current = true;
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
        virtualizer.scrollToIndex(index, { align: opts?.align ?? 'center', behavior: opts?.behavior });
      }
    }),
    [evaluateBoundaries, virtualizer]
  );

  return (
    <div
      aria-live={ariaLive}
      className={className}
      onScroll={(event) =>
        evaluateBoundaries(virtualizer, {
          clientHeight: event.currentTarget.clientHeight,
          scrollHeight: event.currentTarget.scrollHeight,
          scrollTop: event.currentTarget.scrollTop
        })
      }
      ref={scrollerRef}
      role={role}
      style={{ height: '100%', overflowAnchor: 'none', overflowY: 'auto', ...style }}
    >
      <div ref={headerRef}>{header}</div>
      <div style={{ height: totalSize, position: 'relative', width: '100%' }}>
        {scrollerReady &&
          virtualItems.map((virtualRow) => {
            const item = items[virtualRow.index];
            const content = item === undefined && hasFooter ? footer : item === undefined ? null : renderItem(item);
            if (content === null) return null;
            return (
              <div
                data-index={virtualRow.index}
                key={virtualRow.key}
                ref={virtualizer.measureElement}
                style={{ ...ROW_STYLE_BASE, transform: `translateY(${virtualRow.start - headerHeight}px)` }}
              >
                {content}
              </div>
            );
          })}
      </div>
    </div>
  );
}
