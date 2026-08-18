import { VirtualList, type VirtualListHandle } from '@monad/ui/components/VirtualList';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import sessionTranscript from './session-transcript.json';

/**
 * Standalone harness for the VirtualList e2e spec. Driven entirely through `window.harness` so the
 * spec controls timing (no intervals racing the assertions), and served straight off the app's Vite
 * dev server — the behaviours under test are layout races that only reproduce in a real browser.
 */

type Row = { id: string; text: string };

const LOREM =
  'Virtual scrolling keeps the DOM small by rendering only the rows near the viewport. Measured heights replace estimates as rows mount. ';

function makeRow(index: number): Row {
  // Every fifth row is an order of magnitude taller than the rest, so estimate-vs-measured gaps are
  // the norm rather than the edge case. `smallRows=1` suppresses the tall rows so a handful of rows
  // genuinely underfills the viewport (the no-overflow paging case).
  const small = new URLSearchParams(window.location.search).get('smallRows') === '1';
  return { id: `row_${index}`, text: `#${index} ${LOREM.repeat(!small && index % 5 === 0 ? 40 : 2)}` };
}

/**
 * A real transcript captured from a running daemon: 146 rows whose text spans two characters to
 * five thousand, so the estimate a row carries before it mounts is wrong by an order of magnitude in
 * both directions. Synthetic rows with two height buckets cannot reproduce that.
 */
const SESSION_ROWS: Row[] = (sessionTranscript as { id: string; role: string; text: string }[]).map((message) => ({
  id: message.id,
  text: `${message.role}: ${message.text}`
}));

function initialRows(): Row[] {
  const dataset = new URLSearchParams(window.location.search).get('dataset');
  if (dataset === 'session') return SESSION_ROWS;
  const count = Number(new URLSearchParams(window.location.search).get('rows')) || 80;
  return Array.from({ length: count }, (_, index) => makeRow(index));
}

declare global {
  interface Window {
    harness: {
      appendRow: () => void;
      dragScrollbarToTop: (holdMs?: number) => Promise<void>;
      enableTopPagingCursor: () => void;
      /** Remember where a given row sits in the viewport, to measure later drift against. */
      anchor: () => { id: string | null; offset: number | null };
      /** How far the anchored row has moved in the viewport since `anchor()` — non-zero is a jump. */
      anchorDrift: () => number;
      growLastRow: (times?: number) => void;
      growLastRowInDom: (px?: number) => void;
      prependRows: (count?: number) => void;
      prependMergingToolRows: (count?: number) => void;
      jumpToLatest: (behavior?: 'auto' | 'smooth') => void;
      jumpToLoadedTop: () => void;
      jumpToTop: (behavior?: 'auto' | 'smooth') => void;
      scrollToKey: (key: string) => void;
      setViewportOverlay: (visible: boolean) => void;
      state: () => {
        atBottom: boolean;
        distanceFromBottom: number;
        renderedCount: number;
        scrollHeight: number;
        scrollTop: number;
        topLoading: boolean;
        topVisibleRowId: string | null;
        topVisibleRowOffset: number | null;
        topLoadCount: number;
      };
    };
  }
}

// Mimics content that reflows shortly after mount — a code block swapping in syntax highlighting,
// an image resolving its dimensions. Every third row mounts 83px taller than it settles, so each
// pass across it re-triggers the late shrink the virtual list must absorb invisibly.
function RowView({ row, lateReflow }: { row: Row; lateReflow: boolean }): React.ReactElement {
  const reflows = lateReflow && Number.parseInt(row.id.replace(/^row_-?/, ''), 10) % 3 === 0;
  const [settled, setSettled] = useState(!reflows);
  useEffect(() => {
    if (settled) return;
    const timer = window.setTimeout(() => setSettled(true), 180);
    return () => window.clearTimeout(timer);
  }, [settled]);
  return (
    <div
      data-row-id={row.id}
      style={{ borderBottom: '1px solid #ddd', boxSizing: 'border-box', padding: '12px 16px' }}
    >
      {row.text}
      {reflows && !settled ? <div style={{ height: 83 }} /> : null}
    </div>
  );
}

function Harness(): React.ReactElement {
  const [rows, setRows] = useState<Row[]>(initialRows);
  const [atBottom, setAtBottom] = useState(true);
  const listRef = useRef<VirtualListHandle>(null);
  const nextPrependRef = useRef(-1);
  const topLoadCountRef = useRef(0);
  const topLoadingRef = useRef(false);
  const [topLoading, setTopLoading] = useState(false);
  const [viewportOverlayVisible, setViewportOverlayVisible] = useState(false);
  const anchorRef = useRef<{ id: string; offset: number; scrollTop: number } | null>(null);
  const topPagingMode = new URLSearchParams(window.location.search).get('topPaging');
  const autoFillStart = new URLSearchParams(window.location.search).get('autoFillStart') === '1';
  const [topCanLoad, setTopCanLoad] = useState(topPagingMode !== 'deferred');
  const topPaging =
    topPagingMode === '1' ||
    topPagingMode === 'merge' ||
    topPagingMode === 'deferred' ||
    topPagingMode === 'cachedPage';

  const loadOlderAtTop = useCallback(() => {
    if (!topPaging || !topCanLoad) return false;
    if (topLoadingRef.current || topLoadCountRef.current >= 5) return true;
    if (topPagingMode === 'cachedPage') {
      // A page served from the RTK cache lands in a microtask, not after network latency, and it
      // carries a whole page of mixed-height rows — the case where mid-scroll prepends jump.
      topLoadingRef.current = true;
      topLoadCountRef.current += 1;
      queueMicrotask(() => {
        setRows((previous) => {
          const older = Array.from({ length: 20 }, () => {
            const next = makeRow(nextPrependRef.current);
            nextPrependRef.current -= 1;
            return next;
          }).reverse();
          return [...older, ...previous];
        });
        topLoadingRef.current = false;
      });
      return true;
    }
    topLoadingRef.current = true;
    setTopLoading(true);
    window.setTimeout(() => {
      topLoadCountRef.current += 1;
      // Mirrors a page fetch that started (the edge disarmed) but failed: the attempt counts, no
      // rows arrive, and the reader is left parked at the loaded top.
      if (
        new URLSearchParams(window.location.search).get('failFirstTopLoad') === '1' &&
        topLoadCountRef.current === 1
      ) {
        topLoadingRef.current = false;
        setTopLoading(false);
        return;
      }
      setRows((previous) => {
        if (topPagingMode === 'merge') {
          const [firstRow, ...rest] = previous;
          if (!firstRow) return previous;
          const next = makeRow(nextPrependRef.current);
          nextPrependRef.current -= 1;
          return [{ ...firstRow, text: `${next.text} ${firstRow.text}` }, ...rest];
        }
        const next = makeRow(nextPrependRef.current);
        nextPrependRef.current -= 1;
        return [next, ...previous];
      });
      topLoadingRef.current = false;
      setTopLoading(false);
    }, 150);
    return true;
  }, [topCanLoad, topPaging, topPagingMode]);

  const lateReflow = new URLSearchParams(window.location.search).get('lateReflow') === '1';
  const renderItem = useCallback(
    (row: Row) => (
      <RowView
        lateReflow={lateReflow}
        row={row}
      />
    ),
    [lateReflow]
  );

  const rowOffsetOf = (id: string): number | null => {
    const scroller = document.querySelector<HTMLElement>('[role="log"]');
    const row = scroller?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`);
    if (!scroller || !row) return null;
    return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  };

  window.harness = {
    anchor: () => {
      const state = window.harness.state();
      const scroller = document.querySelector<HTMLElement>('[role="log"]');
      if (state.topVisibleRowId === null || !scroller) {
        anchorRef.current = null;
        return { id: null, offset: null };
      }
      anchorRef.current = {
        id: state.topVisibleRowId,
        offset: rowOffsetOf(state.topVisibleRowId) ?? 0,
        scrollTop: scroller.scrollTop
      };
      return { id: anchorRef.current.id, offset: anchorRef.current.offset };
    },
    // How far the anchored row has travelled across the VIEWPORT since `anchor()`. A gesture is
    // supposed to move it by exactly the gesture's own distance; the caller subtracts that. What is
    // left is content moving under the reader — the jump. Deliberately not measured in document
    // space: rows measuring above the anchor move its document position on purpose, and the scroll
    // correction that compensates them is the fix, not the fault.
    anchorDrift: () => {
      const anchored = anchorRef.current;
      if (!anchored) return 0;
      const offset = rowOffsetOf(anchored.id);
      return offset === null ? Number.NaN : offset - anchored.offset;
    },
    appendRow: () => setRows((previous) => [...previous, makeRow(previous.length)]),
    dragScrollbarToTop: async (holdMs = 400) => {
      const scroller = document.querySelector<HTMLElement>('[role="log"]');
      if (!scroller) return;
      scroller.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      scroller.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    },
    enableTopPagingCursor: () => setTopCanLoad(true),
    growLastRow: (times = 1) =>
      setRows((previous) => {
        const last = previous.at(-1);
        if (!last) return previous;
        const grown = { ...last, text: `${last.text}${' streamed tokens arriving in place.'.repeat(times)}` };
        return [...previous.slice(0, -1), grown];
      }),
    // Growth with no React involvement at all — an image finishing its load, a font swapping in.
    // Only the row's ResizeObserver reports it, so nothing re-renders and no effect re-pins.
    growLastRowInDom: (px = 400) => {
      const rows = document.querySelectorAll<HTMLElement>('[role="log"] [data-row-id]');
      const last = rows[rows.length - 1];
      if (!last) return;
      const spacer = document.createElement('div');
      spacer.style.height = `${px}px`;
      last.append(spacer);
    },
    // Observation can merge older adjacent tool entries into the first loaded row. The row keeps
    // its persistent key, while its measured height grows upward from the loaded boundary.
    prependMergingToolRows: (count = 3) =>
      setRows((previous) => {
        const [firstRow, ...rest] = previous;
        if (!firstRow) return previous;
        const older: Row[] = [];
        for (let index = 0; index < count; index += 1) {
          older.unshift({ id: `tool_${nextPrependRef.current}`, text: `older tool call ${nextPrependRef.current}` });
          nextPrependRef.current -= 1;
        }
        const merged: Row = { id: firstRow.id, text: `${older.map((row) => row.text).join(' ')} ${firstRow.text}` };
        return [merged, ...rest];
      }),
    prependRows: (count = 5) =>
      setRows((previous) => {
        const older: Row[] = [];
        for (let index = 0; index < count; index += 1) {
          older.unshift(makeRow(nextPrependRef.current));
          nextPrependRef.current -= 1;
        }
        return [...older, ...previous];
      }),
    jumpToLatest: (behavior = 'auto') => listRef.current?.scrollToBottom(behavior),
    jumpToLoadedTop: () => {
      // Only scroll to the physical top of the loaded rows. Loading the next page is the scroll
      // control's job: landing at the top must re-arm and evaluate the start edge, which fires
      // `onStartReached` exactly once. No explicit load here — a second trigger source is the bug.
      listRef.current?.scrollToTop('auto');
    },
    jumpToTop: (behavior = 'auto') => listRef.current?.scrollToTop(behavior),
    scrollToKey: (key) => listRef.current?.scrollToKey(key, { align: 'start' }),
    setViewportOverlay: setViewportOverlayVisible,
    state: () => {
      const scroller = document.querySelector<HTMLElement>('[role="log"]');
      if (!scroller) {
        return {
          atBottom,
          distanceFromBottom: -1,
          renderedCount: 0,
          scrollHeight: -1,
          scrollTop: -1,
          topLoading,
          topVisibleRowId: null,
          topVisibleRowOffset: null,
          topLoadCount: topLoadCountRef.current
        };
      }
      const viewportTop = scroller.getBoundingClientRect().top;
      const rendered = [...scroller.querySelectorAll<HTMLElement>('[data-row-id]')];
      // The row the reader is actually looking at: the first one still crossing the viewport top.
      const topVisible = rendered.find((row) => row.getBoundingClientRect().bottom > viewportTop + 1);
      return {
        atBottom,
        distanceFromBottom: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight),
        renderedCount: rendered.length,
        scrollHeight: scroller.scrollHeight,
        scrollTop: Math.round(scroller.scrollTop),
        topLoading,
        topVisibleRowId: topVisible?.dataset.rowId ?? null,
        topVisibleRowOffset: topVisible ? Math.round(topVisible.getBoundingClientRect().top - viewportTop) : null,
        topLoadCount: topLoadCountRef.current
      };
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <VirtualList
          autoLoadStartWhenUnderfilled={
            autoFillStart ? { canLoad: topCanLoad && topLoadCountRef.current < 5, loading: topLoading } : undefined
          }
          controlRef={listRef}
          getKey={(row) => row.id}
          header={
            topPaging ? (
              <div data-top-loading={topLoading ? 'true' : 'false'}>{topLoading ? 'Loading earlier rows…' : ''}</div>
            ) : undefined
          }
          items={rows}
          onAtBottomChange={setAtBottom}
          onStartReached={topPaging ? loadOlderAtTop : undefined}
          overscan={Number(new URLSearchParams(window.location.search).get('overscan')) || undefined}
          renderItem={renderItem}
          role="log"
          settleAtBottomOnLoad={new URLSearchParams(window.location.search).get('settleOnLoad') === '1'}
          stickToBottom
          viewportOverlay={
            viewportOverlayVisible ? (
              <div
                data-viewport-overlay
                style={{
                  background: 'linear-gradient(to top, white, transparent)',
                  height: 96,
                  pointerEvents: 'none'
                }}
              />
            ) : undefined
          }
        />
      </div>
    </div>
  );
}

const container = document.getElementById('root');
if (container) createRoot(container).render(<Harness />);
