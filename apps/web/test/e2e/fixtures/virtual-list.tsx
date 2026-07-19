import { VirtualList, type VirtualListHandle } from '@monad/ui/components/VirtualList';
import { useCallback, useRef, useState } from 'react';
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
  // the norm rather than the edge case.
  return { id: `row_${index}`, text: `#${index} ${LOREM.repeat(index % 5 === 0 ? 40 : 2)}` };
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
  return Array.from({ length: 80 }, (_, index) => makeRow(index));
}

declare global {
  interface Window {
    harness: {
      appendRow: () => void;
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
      state: () => {
        atBottom: boolean;
        distanceFromBottom: number;
        renderedCount: number;
        scrollHeight: number;
        scrollTop: number;
        topVisibleRowId: string | null;
        topVisibleRowOffset: number | null;
        topLoadCount: number;
      };
    };
  }
}

function Harness(): React.ReactElement {
  const [rows, setRows] = useState<Row[]>(initialRows);
  const [atBottom, setAtBottom] = useState(true);
  const listRef = useRef<VirtualListHandle>(null);
  const nextPrependRef = useRef(-1);
  const topLoadCountRef = useRef(0);
  const anchorRef = useRef<{ id: string; offset: number; scrollTop: number } | null>(null);
  const topPaging = new URLSearchParams(window.location.search).get('topPaging') === '1';

  const loadOlderAtTop = useCallback(() => {
    if (!topPaging || topLoadCountRef.current >= 5) return;
    topLoadCountRef.current += 1;
    setRows((previous) => {
      const next = makeRow(nextPrependRef.current);
      nextPrependRef.current -= 1;
      return [next, ...previous];
    });
  }, [topPaging]);

  const renderItem = useCallback(
    (row: Row) => (
      <div
        data-row-id={row.id}
        style={{ borderBottom: '1px solid #ddd', boxSizing: 'border-box', padding: '12px 16px' }}
      >
        {row.text}
      </div>
    ),
    []
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
      return offset === null ? 0 : offset - anchored.offset;
    },
    appendRow: () => setRows((previous) => [...previous, makeRow(previous.length)]),
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
    // Observation regroups ADJACENT tool entries into one `tool-group:<lastEntryId>` row, so older
    // history arriving above a lone tool row does not merely insert above it — it MERGES INTO it:
    // the row keyed `t1` is replaced by a taller row keyed `tool-group:t1`, and `t1` disappears.
    // The generic prepend case only ever inserts rows with fresh keys above a stable top row, so it
    // cannot catch an anchor that is pinned to a key rather than to a position. (The grouping rule
    // itself is unit-covered in @monad/atoms; what this reproduces is the resulting key transition.)
    prependMergingToolRows: (count = 3) =>
      setRows((previous) => {
        const [firstRow, ...rest] = previous;
        if (!firstRow) return previous;
        const older: Row[] = [];
        for (let index = 0; index < count; index += 1) {
          older.unshift({ id: `tool_${nextPrependRef.current}`, text: `older tool call ${nextPrependRef.current}` });
          nextPrependRef.current -= 1;
        }
        const merged: Row = {
          id: `tool-group:${firstRow.id}`,
          text: `${older.map((row) => row.text).join(' ')} ${firstRow.text}`
        };
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
      listRef.current?.scrollToTop('auto');
      loadOlderAtTop();
    },
    jumpToTop: (behavior = 'auto') => listRef.current?.scrollToTop(behavior),
    scrollToKey: (key) => listRef.current?.scrollToKey(key, { align: 'start' }),
    state: () => {
      const scroller = document.querySelector<HTMLElement>('[role="log"]');
      if (!scroller) {
        return {
          atBottom,
          distanceFromBottom: -1,
          renderedCount: 0,
          scrollHeight: -1,
          scrollTop: -1,
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
          controlRef={listRef}
          getKey={(row) => row.id}
          items={rows}
          onAtBottomChange={setAtBottom}
          onStartReached={topPaging ? loadOlderAtTop : undefined}
          renderItem={renderItem}
          role="log"
          stickToBottom
        />
      </div>
    </div>
  );
}

const container = document.getElementById('root');
if (container) createRoot(container).render(<Harness />);
