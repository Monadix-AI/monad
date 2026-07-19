import type { RawFrameRow } from '../../../../../packages/atoms/src/workspace-experiences/chat-room/components/observation/raw-view.ts';

import { useCallback, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { MeshAgentObservationPanel } from '../../../../../packages/atoms/src/workspace-experiences/chat-room/components/observation/panel.tsx';
import {
  RawObservationList,
  type RawObservationListHandle
} from '../../../../../packages/atoms/src/workspace-experiences/chat-room/components/observation/raw-observation-list.tsx';

/**
 * Drives the REAL MeshAgentObservationPanel with a RawObservationList as its `content`, wired
 * through the same `contentControlRef` the panel forwards its Scroll-to-top button to. This is the
 * runtime coverage the SSR/pure-function unit tests cannot give: that the panel's top button
 * reaches the list's VirtualList scroll control, that the list spreads its control props into
 * VirtualList (so a jump-to-top fires `onLoadOlderEvents` exactly once), that a raw card body is
 * actually painted client-side, and that a prepended page does not chain-load.
 */

const LOREM =
  'Provider-native raw frame body. Exact bytes are shown verbatim in a preformatted block so the reader can inspect the unnormalized payload. ';

function makeRow(index: number): RawFrameRow {
  return {
    identity: `raw_${index}`,
    cursor: `provider:raw_${index}`,
    stream: 'stdout',
    preview: `#${index} ${LOREM.repeat(3)}`
  };
}

declare global {
  interface Window {
    observationHarness: {
      prependReset: () => void;
      state: () => {
        loadCount: number;
        loadedTopRowOffset: number | null;
        loadingHeader: boolean;
        rowCount: number;
        bottomBodyText: string | null;
        scrollTop: number;
        topVisibleRowId: string | null;
      };
    };
  }
}

function Harness(): React.ReactElement {
  const [rows, setRows] = useState<RawFrameRow[]>(() => Array.from({ length: 24 }, (_, index) => makeRow(index)));
  const [loadingOlder, setLoadingOlder] = useState(false);
  const rawRef = useRef<RawObservationListHandle>(null);
  const loadCountRef = useRef(0);
  const loadingRef = useRef(false);
  const nextPrependRef = useRef(-1);

  const onLoadOlderEvents = useCallback(() => {
    if (loadingRef.current || loadCountRef.current >= 5) return;
    loadingRef.current = true;
    setLoadingOlder(true);
    window.setTimeout(() => {
      loadCountRef.current += 1;
      setRows((previous) => {
        const older: RawFrameRow[] = [];
        for (let index = 0; index < 5; index += 1) {
          older.unshift(makeRow(nextPrependRef.current));
          nextPrependRef.current -= 1;
        }
        return [...older, ...previous];
      });
      loadingRef.current = false;
      setLoadingOlder(false);
    }, 150);
  }, []);

  window.observationHarness = {
    prependReset: () => {
      loadCountRef.current = 0;
    },
    state: () => {
      const scroller = document.querySelector<HTMLElement>('[role="log"]');
      const pres = [...document.querySelectorAll<HTMLElement>('[data-observation-raw-preview]')];
      const viewportTop = scroller?.getBoundingClientRect().top ?? 0;
      const loadedTopRow = scroller?.querySelector<HTMLElement>('[data-raw-card-id="raw_0"]');
      const topVisible = scroller
        ? [...scroller.querySelectorAll<HTMLElement>('[data-raw-card-id]')].find(
            (row) => row.getBoundingClientRect().bottom > viewportTop + 1
          )
        : undefined;
      return {
        loadCount: loadCountRef.current,
        loadedTopRowOffset: loadedTopRow ? Math.round(loadedTopRow.getBoundingClientRect().top - viewportTop) : null,
        loadingHeader: !!document.querySelector('[data-events-state="loading"]'),
        rowCount: pres.length,
        bottomBodyText: pres.at(-1)?.textContent ?? null,
        scrollTop: scroller ? Math.round(scroller.scrollTop) : -1,
        topVisibleRowId: topVisible?.dataset.rawCardId ?? null
      };
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <MeshAgentObservationPanel
        agentName="Observed Agent"
        canLoadOlderEvents={loadCountRef.current < 5}
        content={
          <RawObservationList
            canLoadOlderEvents={loadCountRef.current < 5}
            controlRef={rawRef}
            loadingOlderEvents={loadingOlder}
            onLoadOlderEvents={onLoadOlderEvents}
            rows={rows}
          />
        }
        contentControlRef={rawRef}
        contentHasItems
        loadingOlderEvents={loadingOlder}
        onLoadOlderEvents={onLoadOlderEvents}
        showObservationControls={false}
      />
    </div>
  );
}

const container = document.getElementById('root');
if (container) createRoot(container).render(<Harness />);
