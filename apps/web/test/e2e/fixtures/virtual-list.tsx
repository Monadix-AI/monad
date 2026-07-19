import { VirtualList, type VirtualListHandle } from '@monad/ui/components/VirtualList';
import { useCallback, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

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

declare global {
  interface Window {
    harness: {
      appendRow: () => void;
      growLastRow: (times?: number) => void;
      growLastRowInDom: (px?: number) => void;
      prependRows: (count?: number) => void;
      jumpToLatest: (behavior?: 'auto' | 'smooth') => void;
      scrollToKey: (key: string) => void;
      state: () => {
        atBottom: boolean;
        distanceFromBottom: number;
        renderedCount: number;
        scrollHeight: number;
        scrollTop: number;
        topVisibleRowId: string | null;
        topVisibleRowOffset: number | null;
      };
    };
  }
}

function Harness(): React.ReactElement {
  const [rows, setRows] = useState<Row[]>(() => Array.from({ length: 80 }, (_, index) => makeRow(index)));
  const [atBottom, setAtBottom] = useState(true);
  const listRef = useRef<VirtualListHandle>(null);
  const nextPrependRef = useRef(-1);

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

  window.harness = {
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
          topVisibleRowOffset: null
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
        topVisibleRowOffset: topVisible ? Math.round(topVisible.getBoundingClientRect().top - viewportTop) : null
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
