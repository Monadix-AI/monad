import type { CSSProperties, ReactNode, Ref } from 'react';
import type { StateSnapshot, VirtuosoHandle } from 'react-virtuoso';

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { Virtuoso } from 'react-virtuoso';

export interface VirtualListHandle {
  /** Jump to the latest row (and re-arm bottom-following). */
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  /** Scroll a specific item into view by its key (e.g. a mentioned/searched message). */
  scrollToKey: (key: string, opts?: { align?: 'start' | 'center' | 'end'; behavior?: 'auto' | 'smooth' }) => void;
  /** Capture the current scroll position so it can be restored later via `restoreStateFrom`. */
  getState: () => Promise<StateSnapshot>;
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
  /** Imperative control (scrollToBottom/scrollToKey/getState). */
  controlRef?: Ref<VirtualListHandle>;
  /** Fired when the viewport crosses into/out of the bottom — drive a "jump to latest" affordance. */
  onAtBottomChange?: (atBottom: boolean) => void;
  /** Index of `items[0]` in the full virtual list. Decrement it when prepending older rows so the
      viewport stays anchored instead of jumping (chat history pagination). */
  firstItemIndex?: number;
  /** Fired when the user scrolls near the top — load older rows here. */
  onStartReached?: () => void;
  /** Fired when the user scrolls near the bottom — load newer rows here (history-mode paging). */
  onEndReached?: () => void;
  /** Fired when the virtualized viewport range changes. */
  onRangeChange?: (range: { endIndex: number; startIndex: number }) => void;
  /** Restore a position captured earlier via the handle's `getState` (e.g. across route changes). */
  restoreStateFrom?: StateSnapshot;
  /** ARIA role for the scroll region (e.g. "log" for a chat transcript). */
  role?: string;
  /** ARIA live politeness for the scroll region. */
  ariaLive?: 'off' | 'polite' | 'assertive';
  className?: string;
  style?: CSSProperties;
}

interface SlotContext {
  header?: ReactNode;
  footer?: ReactNode;
}

// Stable component identities (Virtuoso remounts the slots if these change each render);
// the actual nodes ride along via `context`, which can update freely.
const HeaderSlot = ({ context }: { context?: SlotContext }) => <>{context?.header ?? null}</>;
const FooterSlot = ({ context }: { context?: SlotContext }) => <>{context?.footer ?? null}</>;
const VIRTUOSO_COMPONENTS = { Header: HeaderSlot, Footer: FooterSlot };

/** Px from the true bottom within which the user still counts as "pinned". */
const STICK_THRESHOLD = 32;
const TRUE_BOTTOM_THRESHOLD = 1;
const USER_SCROLL_INTENT_MS = 300;
const SCROLL_KEYS = new Set(['ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp', ' ']);

/** True when the scroll position is within `threshold` px of the very bottom. */
export function isAtBottom(
  metrics: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = STICK_THRESHOLD
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

/** Position of the item with `key`, or -1. Used by the scrollToKey handle. */
export function indexOfKey<T>(items: T[], getKey: (item: T) => string, key: string, firstItemIndex = 0): number {
  const index = items.findIndex((item) => getKey(item) === key);
  return index < 0 ? -1 : firstItemIndex + index;
}

/**
 * Decide the next pinned state for a scroll event. The crux: a scroll event we caused
 * ourselves (pinning to the bottom) must be ignored — it would otherwise read as the user
 * arriving at the bottom and re-arm following they may have just cancelled. Genuine scroll
 * events set pinned purely from whether the viewport is at the bottom.
 */
export function reducePinnedOnScroll(
  prevPinned: boolean,
  selfScroll: boolean,
  atBottom: boolean,
  direction: 'up' | 'down' | 'none' = 'none'
): { pinned: boolean; selfScrollConsumed: boolean } {
  if (selfScroll) return { pinned: prevPinned, selfScrollConsumed: true };
  if (direction === 'up') return { pinned: false, selfScrollConsumed: false };
  return { pinned: atBottom, selfScrollConsumed: false };
}

export function shouldPinToBottom(stickToBottom: boolean, pinned: boolean): boolean {
  return stickToBottom && pinned;
}

export function shouldPublishAtBottomChange(nextAtBottom: boolean, pinned: boolean, userScrolled: boolean): boolean {
  return nextAtBottom || (!pinned && userScrolled);
}

export type BottomScrollRequest = { active: boolean; behavior: 'auto' | 'smooth' };
export type BottomScrollEvent =
  | { type: 'request'; behavior: 'auto' | 'smooth' }
  | { type: 'height-changed' | 'settle-timeout' | 'user-scroll-up' };

export const initialBottomScrollRequest: BottomScrollRequest = { active: false, behavior: 'auto' };

export function initialBottomScrollRequestFor(
  stickToBottom: boolean,
  restoring: boolean,
  itemCount: number
): BottomScrollRequest {
  return stickToBottom && !restoring && itemCount > 0 ? { active: true, behavior: 'auto' } : initialBottomScrollRequest;
}

export function reduceBottomScrollRequest(state: BottomScrollRequest, event: BottomScrollEvent): BottomScrollRequest {
  if (event.type === 'request') return { active: true, behavior: event.behavior };
  if ((event.type === 'height-changed' || event.type === 'settle-timeout') && state.active) {
    return { active: true, behavior: 'auto' };
  }
  if (event.type === 'user-scroll-up') return initialBottomScrollRequest;
  return state;
}

export function scrollTopPreservingAnchor(scrollTop: number, previousTop: number, currentTop: number): number {
  return scrollTop + currentTop - previousTop;
}

// Generic windowed list over react-virtuoso. The custom pinning below exists because
// virtuoso's built-in `followOutput` does not re-pin when a row grows IN PLACE (a streaming
// message) — only on item-count changes. We instead pin from `totalListHeightChanged`
// (fires on append, initial measurement settling, and in-place growth), gated by a
// self-measured at-bottom check so we never fight a user who has scrolled up.
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
  firstItemIndex,
  onStartReached,
  onEndReached,
  onRangeChange,
  restoreStateFrom,
  role,
  ariaLive,
  className,
  style
}: VirtualListProps<T>): React.ReactElement {
  const context = useMemo<SlotContext>(() => ({ header, footer }), [header, footer]);
  const handleRef = useRef<VirtuosoHandle>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const bottomRequestRef = useRef<BottomScrollRequest>(
    initialBottomScrollRequestFor(stickToBottom, Boolean(restoreStateFrom), items.length)
  );
  const bottomSettleTimeoutRef = useRef<number | undefined>(undefined);
  // `pinnedRef` tracks whether we keep following the bottom. Detection rests on one fact:
  // content growth (a row expanding, new rows) does NOT fire a scroll event — only the user
  // and our own pinning move the scrollbar. So we read "is the user at the bottom" purely
  // from genuine scroll events, and ignore the scroll events our own pinning generates
  // (flagged via `selfScrollRef`) so a streaming pin never looks like the user arriving.
  const pinnedRef = useRef(true);
  const selfScrollRef = useRef(false);
  const userScrolledRef = useRef(false);
  const userScrollIntentUntilRef = useRef(0);
  const lastScrollTopRef = useRef<number | null>(null);
  const viewportResizeObserverRef = useRef<ResizeObserver | null>(null);
  const layoutAnchorRef = useRef<{ element: HTMLElement; top: number; expiresAt: number } | null>(null);

  const clearBottomSettleTimeout = useCallback(() => {
    window.clearTimeout(bottomSettleTimeoutRef.current);
    bottomSettleTimeoutRef.current = undefined;
  }, []);

  const scrollToLast = useCallback((behavior: 'auto' | 'smooth') => {
    selfScrollRef.current = true;
    const scroller = scrollerRef.current;
    if (scroller) {
      scroller.scrollTo({ behavior, top: scroller.scrollHeight });
      return;
    }
    handleRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior });
  }, []);

  const markUserScrollIntent = useCallback(() => {
    userScrollIntentUntilRef.current = performance.now() + USER_SCROLL_INTENT_MS;
  }, []);

  const captureLayoutAnchor = useCallback((target: EventTarget | null) => {
    if (!(target instanceof Element)) return;
    const element = target.closest<HTMLElement>('[data-virtual-list-anchor="true"]');
    if (!element) return;
    layoutAnchorRef.current = {
      element,
      top: element.getBoundingClientRect().top,
      expiresAt: performance.now() + 500
    };
  }, []);

  const handleAnchorPointerDown = useCallback(
    (event: PointerEvent) => {
      if (event.target === scrollerRef.current) markUserScrollIntent();
      captureLayoutAnchor(event.target);
    },
    [captureLayoutAnchor, markUserScrollIntent]
  );

  const handleAnchorKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) markUserScrollIntent();
      if (event.key === 'Enter' || event.key === ' ') captureLayoutAnchor(event.target);
    },
    [captureLayoutAnchor, markUserScrollIntent]
  );

  const measurePinned = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const previousTop = lastScrollTopRef.current;
    const direction =
      previousTop === null ? 'none' : el.scrollTop < previousTop ? 'up' : el.scrollTop > previousTop ? 'down' : 'none';
    lastScrollTopRef.current = el.scrollTop;
    if (bottomRequestRef.current.active) {
      if (isAtBottom(el, TRUE_BOTTOM_THRESHOLD)) {
        selfScrollRef.current = false;
        onAtBottomChange?.(true);
        return;
      }
      if (direction === 'up' && performance.now() <= userScrollIntentUntilRef.current) {
        bottomRequestRef.current = reduceBottomScrollRequest(bottomRequestRef.current, { type: 'user-scroll-up' });
        clearBottomSettleTimeout();
        selfScrollRef.current = false;
        userScrolledRef.current = true;
        pinnedRef.current = false;
      }
      return;
    }
    if (!selfScrollRef.current && direction !== 'none') userScrolledRef.current = true;
    const next = reducePinnedOnScroll(pinnedRef.current, selfScrollRef.current, isAtBottom(el), direction);
    pinnedRef.current = next.pinned;
    if (next.selfScrollConsumed) selfScrollRef.current = false;
  }, [clearBottomSettleTimeout, onAtBottomChange]);

  const pinToBottom = useCallback(() => {
    if (!shouldPinToBottom(stickToBottom, pinnedRef.current)) return;
    const el = scrollerRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    if (el.scrollTop < max) {
      selfScrollRef.current = true;
      el.scrollTop = el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
    }
  }, [stickToBottom]);

  const preserveLayoutAnchor = useCallback(() => {
    const anchor = layoutAnchorRef.current;
    const el = scrollerRef.current;
    if (!anchor || !el) return false;
    if (!anchor.element.isConnected || performance.now() > anchor.expiresAt) {
      layoutAnchorRef.current = null;
      return false;
    }
    const nextScrollTop = scrollTopPreservingAnchor(
      el.scrollTop,
      anchor.top,
      anchor.element.getBoundingClientRect().top
    );
    if (Math.abs(nextScrollTop - el.scrollTop) > 0.5) {
      selfScrollRef.current = true;
      el.scrollTop = nextScrollTop;
      lastScrollTopRef.current = el.scrollTop;
    }
    return true;
  }, []);

  // Pin now, then once more next frame: a freshly appended row reports its real height a
  // frame after it mounts, so a single re-pin catches the residual gap that one pass leaves.
  const pinToBottomSoon = useCallback(() => {
    if (preserveLayoutAnchor()) {
      requestAnimationFrame(preserveLayoutAnchor);
      return;
    }
    if (userScrolledRef.current && !pinnedRef.current) return;
    pinToBottom();
    requestAnimationFrame(pinToBottom);
  }, [pinToBottom, preserveLayoutAnchor]);

  const requestBottomScroll = useCallback(
    (behavior: 'auto' | 'smooth') => {
      clearBottomSettleTimeout();
      pinnedRef.current = true;
      userScrolledRef.current = false;
      layoutAnchorRef.current = null;
      bottomRequestRef.current = reduceBottomScrollRequest(bottomRequestRef.current, { type: 'request', behavior });
      userScrollIntentUntilRef.current = 0;
      scrollToLast(behavior);
      if (behavior !== 'smooth') return;
      bottomSettleTimeoutRef.current = window.setTimeout(() => {
        if (!bottomRequestRef.current.active) return;
        bottomRequestRef.current = reduceBottomScrollRequest(bottomRequestRef.current, { type: 'settle-timeout' });
        scrollToLast('auto');
      }, 600);
    },
    [clearBottomSettleTimeout, scrollToLast]
  );

  const handleAtBottomChange = useCallback(
    (nextAtBottom: boolean) => {
      if (nextAtBottom) {
        const scroller = scrollerRef.current;
        if (!scroller || !isAtBottom(scroller, TRUE_BOTTOM_THRESHOLD)) {
          pinToBottomSoon();
          return;
        }
        selfScrollRef.current = false;
        onAtBottomChange?.(true);
        return;
      }
      if (!shouldPublishAtBottomChange(false, pinnedRef.current, userScrolledRef.current)) {
        pinToBottomSoon();
        return;
      }
      onAtBottomChange?.(false);
    },
    [onAtBottomChange, pinToBottomSoon]
  );

  const handleTotalListHeightChanged = useCallback(() => {
    if (bottomRequestRef.current.active) {
      bottomRequestRef.current = reduceBottomScrollRequest(bottomRequestRef.current, { type: 'height-changed' });
      scrollToLast(bottomRequestRef.current.behavior);
      return;
    }
    pinToBottomSoon();
  }, [pinToBottomSoon, scrollToLast]);

  useImperativeHandle(
    controlRef,
    () => ({
      scrollToBottom: (behavior = 'auto') => {
        requestBottomScroll(behavior === 'smooth' ? 'smooth' : 'auto');
      },
      scrollToKey: (key, opts) => {
        const index = indexOfKey(items, getKey, key, firstItemIndex);
        if (index >= 0) {
          pinnedRef.current = false;
          userScrolledRef.current = true;
          handleRef.current?.scrollToIndex({
            index,
            align: opts?.align ?? 'center',
            behavior: opts?.behavior
          });
        }
      },
      getState: () =>
        new Promise<StateSnapshot>((resolve) => {
          handleRef.current?.getState(resolve);
        })
    }),
    [items, getKey, requestBottomScroll, firstItemIndex]
  );

  // Initial mount lands near — but not exactly at — the bottom because row heights are
  // still being measured (estimates resolve over the first few frames). Re-pin across a
  // short window so we settle on the true bottom; bail the moment the user scrolls away.
  // Skipped when restoring a saved position. Mount-only by design: VirtualList mounts already
  // populated, and every later change is handled by totalListHeightChanged.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional run-once-on-mount
  useEffect(() => {
    if (!stickToBottom || restoreStateFrom || items.length === 0) return;
    let raf = 0;
    const deadline = performance.now() + 700;
    const tick = () => {
      if (userScrolledRef.current) return;
      pinToBottom();
      if (pinnedRef.current && performance.now() < deadline) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const setScroller = useCallback(
    (el: HTMLElement | Window | null) => {
      scrollerRef.current?.removeEventListener('pointerdown', handleAnchorPointerDown);
      scrollerRef.current?.removeEventListener('keydown', handleAnchorKeyDown);
      scrollerRef.current?.removeEventListener('wheel', markUserScrollIntent);
      scrollerRef.current?.removeEventListener('touchmove', markUserScrollIntent);
      viewportResizeObserverRef.current?.disconnect();
      viewportResizeObserverRef.current = null;
      const node = el instanceof HTMLElement ? el : null;
      scrollerRef.current = node;
      if (!node) return;
      node.addEventListener('pointerdown', handleAnchorPointerDown);
      node.addEventListener('keydown', handleAnchorKeyDown);
      node.addEventListener('wheel', markUserScrollIntent, { passive: true });
      node.addEventListener('touchmove', markUserScrollIntent, { passive: true });
      if (typeof ResizeObserver !== 'undefined') {
        viewportResizeObserverRef.current = new ResizeObserver(pinToBottomSoon);
        viewportResizeObserverRef.current.observe(node);
      }
      if (role) node.setAttribute('role', role);
      if (ariaLive) node.setAttribute('aria-live', ariaLive);
    },
    [role, ariaLive, handleAnchorKeyDown, handleAnchorPointerDown, markUserScrollIntent, pinToBottomSoon]
  );

  useEffect(
    () => () => {
      scrollerRef.current?.removeEventListener('pointerdown', handleAnchorPointerDown);
      scrollerRef.current?.removeEventListener('keydown', handleAnchorKeyDown);
      scrollerRef.current?.removeEventListener('wheel', markUserScrollIntent);
      scrollerRef.current?.removeEventListener('touchmove', markUserScrollIntent);
      viewportResizeObserverRef.current?.disconnect();
      viewportResizeObserverRef.current = null;
      clearBottomSettleTimeout();
    },
    [clearBottomSettleTimeout, handleAnchorKeyDown, handleAnchorPointerDown, markUserScrollIntent]
  );

  // Only forward firstItemIndex when paginating: Virtuoso computes `data-item-index` as
  // firstItemIndex + offset, so an explicit `undefined` yields NaN attributes.
  const paginationProps = firstItemIndex === undefined ? {} : { firstItemIndex };
  const initialTopMostItemIndex =
    restoreStateFrom || items.length === 0
      ? undefined
      : stickToBottom
        ? { index: 'LAST' as const, align: 'end' as const }
        : 0;

  return (
    <Virtuoso<T, SlotContext>
      atBottomStateChange={handleAtBottomChange}
      atBottomThreshold={STICK_THRESHOLD}
      className={className}
      components={VIRTUOSO_COMPONENTS}
      computeItemKey={(_index, item) => getKey(item)}
      context={context}
      data={items}
      increaseViewportBy={overscan}
      {...paginationProps}
      endReached={onEndReached}
      initialTopMostItemIndex={initialTopMostItemIndex}
      itemContent={(_index, item) => (
        <div style={{ boxSizing: 'border-box', minWidth: 0, width: '100%' }}>{renderItem(item)}</div>
      )}
      onScroll={measurePinned}
      rangeChanged={onRangeChange}
      ref={handleRef}
      restoreStateFrom={restoreStateFrom}
      scrollerRef={setScroller}
      startReached={onStartReached}
      style={style}
      totalListHeightChanged={handleTotalListHeightChanged}
    />
  );
}
