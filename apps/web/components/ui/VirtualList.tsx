'use client';

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
const STICK_THRESHOLD = 120;

/** True when the scroll position is within `threshold` px of the very bottom. */
export function isAtBottom(
  metrics: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = STICK_THRESHOLD
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

/** Position of the item with `key`, or -1. Used by the scrollToKey handle. */
export function indexOfKey<T>(items: T[], getKey: (item: T) => string, key: string): number {
  return items.findIndex((item) => getKey(item) === key);
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
  atBottom: boolean
): { pinned: boolean; selfScrollConsumed: boolean } {
  if (selfScroll) return { pinned: prevPinned, selfScrollConsumed: true };
  return { pinned: atBottom, selfScrollConsumed: false };
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
  restoreStateFrom,
  role,
  ariaLive,
  className,
  style
}: VirtualListProps<T>): React.ReactElement {
  const context = useMemo<SlotContext>(() => ({ header, footer }), [header, footer]);
  const handleRef = useRef<VirtuosoHandle>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  // `pinnedRef` tracks whether we keep following the bottom. Detection rests on one fact:
  // content growth (a row expanding, new rows) does NOT fire a scroll event — only the user
  // and our own pinning move the scrollbar. So we read "is the user at the bottom" purely
  // from genuine scroll events, and ignore the scroll events our own pinning generates
  // (flagged via `selfScrollRef`) so a streaming pin never looks like the user arriving.
  const pinnedRef = useRef(true);
  const selfScrollRef = useRef(false);

  const measurePinned = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const next = reducePinnedOnScroll(pinnedRef.current, selfScrollRef.current, isAtBottom(el));
    pinnedRef.current = next.pinned;
    if (next.selfScrollConsumed) selfScrollRef.current = false;
  }, []);

  const pinToBottom = useCallback(() => {
    if (!stickToBottom || !pinnedRef.current) return;
    const el = scrollerRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    if (el.scrollTop < max) {
      selfScrollRef.current = true;
      el.scrollTop = el.scrollHeight;
    }
  }, [stickToBottom]);

  // Pin now, then once more next frame: a freshly appended row reports its real height a
  // frame after it mounts, so a single re-pin catches the residual gap that one pass leaves.
  const pinToBottomSoon = useCallback(() => {
    pinToBottom();
    requestAnimationFrame(pinToBottom);
  }, [pinToBottom]);

  useImperativeHandle(
    controlRef,
    () => ({
      scrollToBottom: (behavior = 'auto') => {
        pinnedRef.current = true;
        // Scroll now, then re-settle over the next two frames: rows below the old viewport
        // report their real heights a frame after they mount, so one pass lands short.
        const go = () => {
          const el = scrollerRef.current;
          if (!el) return;
          selfScrollRef.current = true;
          el.scrollTo({ top: el.scrollHeight, behavior });
        };
        go();
        requestAnimationFrame(() => {
          go();
          requestAnimationFrame(go);
        });
      },
      scrollToKey: (key, opts) => {
        const index = indexOfKey(items, getKey, key);
        if (index >= 0) {
          handleRef.current?.scrollToIndex({ index, align: opts?.align ?? 'center', behavior: opts?.behavior });
        }
      },
      getState: () =>
        new Promise<StateSnapshot>((resolve) => {
          handleRef.current?.getState(resolve);
        })
    }),
    [items, getKey]
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
      pinToBottom();
      if (pinnedRef.current && performance.now() < deadline) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const setScroller = useCallback(
    (el: HTMLElement | Window | null) => {
      const node = el instanceof HTMLElement ? el : null;
      scrollerRef.current = node;
      if (node) {
        if (role) node.setAttribute('role', role);
        if (ariaLive) node.setAttribute('aria-live', ariaLive);
      }
    },
    [role, ariaLive]
  );

  // Only forward firstItemIndex when paginating: Virtuoso computes `data-item-index` as
  // firstItemIndex + offset, so an explicit `undefined` yields NaN attributes.
  const paginationProps = firstItemIndex === undefined ? {} : { firstItemIndex };

  return (
    <Virtuoso<T, SlotContext>
      atBottomStateChange={onAtBottomChange}
      atBottomThreshold={STICK_THRESHOLD}
      className={className}
      components={VIRTUOSO_COMPONENTS}
      computeItemKey={(_index, item) => getKey(item)}
      context={context}
      data={items}
      increaseViewportBy={overscan}
      {...paginationProps}
      endReached={onEndReached}
      initialTopMostItemIndex={
        restoreStateFrom ? undefined : stickToBottom && items.length > 0 ? { index: items.length - 1, align: 'end' } : 0
      }
      itemContent={(_index, item) => renderItem(item)}
      onScroll={measurePinned}
      ref={handleRef}
      restoreStateFrom={restoreStateFrom}
      scrollerRef={setScroller}
      startReached={onStartReached}
      style={style}
      totalListHeightChanged={pinToBottomSoon}
    />
  );
}
