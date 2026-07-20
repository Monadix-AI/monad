import type { AgentObservationCard, AgentObservationEvent } from '@monad/protocol';
import type { RawFrameRow } from '../../../../../packages/atoms/src/workspace-experiences/chat-room/components/observation/raw-view.ts';

import { useCallback, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { agentObservationCards } from '../../../../../packages/atoms/src/agent-adapters/observation-cards.ts';
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

function observationEvent(id: string, kind: AgentObservationEvent['kind'], text?: string): AgentObservationEvent {
  return {
    id,
    kind,
    streaming: false,
    ...(text ? { text } : {}),
    provenance: { contractEvents: [{ id, kind, text }] }
  };
}

function makeTurnEvents(agentKey: string, turn: number): AgentObservationEvent[] {
  const body = `${agentKey} turn ${turn} ${LOREM.repeat(turn % 3 === 0 ? 10 : 4)}`;
  return [
    observationEvent(`${agentKey}:turn-${turn}:start`, 'turn-start'),
    observationEvent(`${agentKey}:turn-${turn}:user`, 'user-message', `User request ${turn}`),
    observationEvent(`${agentKey}:turn-${turn}:assistant`, 'assistant-message', body),
    observationEvent(`${agentKey}:turn-${turn}:end`, 'turn-end')
  ];
}

function makeObservationItems(agentKey: string, count = 18): AgentObservationCard[] {
  return agentObservationCards(
    Array.from({ length: count }, (_, index) => makeTurnEvents(agentKey, index)).flat(),
    'codex'
  );
}

declare global {
  interface Window {
    observationHarness: {
      agent: (agentKey: 'agent-a' | 'agent-b') => void;
      prependReset: () => void;
      state: () => {
        distanceFromBottom: number;
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
  const mode = new URLSearchParams(window.location.search).get('mode');
  const [rows, setRows] = useState<RawFrameRow[]>(() => Array.from({ length: 24 }, (_, index) => makeRow(index)));
  const [agentKey, setAgentKey] = useState<'agent-a' | 'agent-b'>('agent-a');
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
    agent: setAgentKey,
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
        distanceFromBottom: scroller
          ? Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight)
          : -1,
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

  if (mode === 'turn') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <MeshAgentObservationPanel
          agentName={agentKey === 'agent-a' ? 'Agent A' : 'Agent B'}
          canLoadOlderEvents={loadCountRef.current < 5}
          defaultRenderMode="summary"
          eventsActive
          loadingOlderEvents={loadingOlder}
          onLoadOlderEvents={onLoadOlderEvents}
          stream={{
            id: agentKey,
            agentName: agentKey === 'agent-a' ? 'Agent A' : 'Agent B',
            provider: 'codex',
            tag: 'Agent',
            status: 'ok',
            output: '',
            items: makeObservationItems(agentKey)
          }}
        />
      </div>
    );
  }

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
