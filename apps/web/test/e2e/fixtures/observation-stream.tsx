import type { AgentObservationEvent } from '@monad/protocol';
import type { MeshAgentStreamView } from '../../../../../packages/atoms/src/workplace-experiences/experience/types.ts';

import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { agentObservationCards } from '../../../../../packages/atoms/src/agent-adapters/observation-cards.ts';
import { MeshAgentObservationPanel } from '../../../../../packages/atoms/src/workplace-experiences/chat-room/components/observation/panel.tsx';

/**
 * Live-stream stress harness for the observation timeline: an event log grows on a timer exactly
 * the way the RTK observation stream feeds the panel (reasoning deltas mutate the tail event's
 * text under a STABLE id; tool call/result pairs and turn boundaries append), and the full card
 * projection is rebuilt from scratch every tick. The harness instruments what a reader would call
 * "flicker": frames where the end-pinned viewport is off the bottom, and DOM remounts of rows
 * whose keys did not change.
 */

const WORDS =
  'the quick brown fox jumps over a lazy dog while tokens stream into the observation panel and cards grow taller line by line '.split(
    ' '
  );

type LogEvent = AgentObservationEvent & { text?: string };

function makeEvent(id: string, kind: AgentObservationEvent['kind'], extra?: Partial<LogEvent>): LogEvent {
  return {
    id,
    kind,
    streaming: false,
    provenance: { contractEvents: [{ id, kind }] },
    at: new Date(1750000000000).toISOString(),
    ...extra
  } as LogEvent;
}

type StreamState = {
  events: LogEvent[];
  tick: number;
  turn: number;
  reasoningId: string | null;
  reasoningWords: number;
};

function advance(state: StreamState): StreamState {
  const events = [...state.events];
  let { turn, reasoningId, reasoningWords } = state;
  const tick = state.tick + 1;

  if (reasoningId) {
    const index = events.findIndex((event) => event.id === reasoningId);
    const current = events[index];
    if (current) {
      reasoningWords += 3;
      const text = Array.from({ length: reasoningWords }, (_, i) => WORDS[i % WORDS.length]).join(' ');
      events[index] = { ...current, text, streaming: true };
    }
    if (reasoningWords >= 45) {
      const index2 = events.findIndex((event) => event.id === reasoningId);
      const current2 = events[index2];
      if (current2) events[index2] = { ...current2, streaming: false };
      reasoningId = null;
    }
  } else if (tick % 7 === 3) {
    turn += 1;
    events.push(makeEvent(`t${turn}:start`, 'turn-start'));
    events.push(makeEvent(`t${turn}:user`, 'user-message', { text: `User request ${turn}` }));
    reasoningId = `t${turn}:reasoning`;
    reasoningWords = 3;
    events.push(makeEvent(reasoningId, 'reasoning', { streaming: true, text: 'the quick brown' }));
  } else if (tick % 7 === 5 && turn > 0) {
    const callId = `t${turn}:call${tick}`;
    events.push(
      makeEvent(`${callId}:call`, 'tool-call', {
        text: `Tool call shell tick ${tick}`,
        tool: { callId, name: 'shell' }
      })
    );
    events.push(
      makeEvent(`${callId}:result`, 'tool-result', {
        text: `exit 0\n${WORDS.slice(0, (tick % 9) + 2).join(' ')}`,
        tool: { callId, name: 'shell' }
      })
    );
  } else if (tick % 7 === 6 && turn > 0) {
    events.push(makeEvent(`t${turn}:assistant${tick}`, 'assistant-message', { text: `Assistant update ${tick}` }));
    events.push(makeEvent(`t${turn}:end${tick}`, 'turn-end'));
  }

  return { events, tick, turn, reasoningId, reasoningWords };
}

declare global {
  interface Window {
    streamHarness: {
      start: () => void;
      stop: () => void;
      metrics: () => {
        bounceFrames: number;
        maxBounce: number;
        frameSamples: number;
        remountEvents: number;
        tick: number;
        rowCount: number;
      };
      scrollUpBy: (px: number) => void;
      anchor: () => { id: string | null };
      anchorDrift: () => number;
      state: () => { distanceFromBottom: number; scrollTop: number };
    };
  }
}

const metrics = {
  bounceFrames: 0,
  maxBounce: 0,
  frameSamples: 0,
  remountEvents: 0,
  remountDetails: [] as { index: string; visible: boolean; key: string | null }[],
  bounceLog: [] as Record<string, number>[]
};
let currentTick = 0;

function scroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="log"]');
}

function distanceFromBottom(node: HTMLElement): number {
  return Math.max(node.scrollHeight - node.scrollTop - node.clientHeight, 0);
}

let anchorRef: { key: string; top: number } | null = null;

function rowByIndex(): Map<string, Element> {
  const map = new Map<string, Element>();
  for (const row of document.querySelectorAll('[role="log"] [data-vl-key]')) {
    const key = row.getAttribute('data-vl-key');
    if (key !== null) map.set(key, row);
  }
  return map;
}

function Harness(): React.ReactElement {
  const [state, setState] = useState<StreamState>(() => {
    let seeded: StreamState = { events: [], tick: 0, turn: 0, reasoningId: null, reasoningWords: 0 };
    for (let index = 0; index < 100; index += 1) seeded = advance(seeded);
    return { ...seeded, reasoningId: null };
  });
  const timerRef = useRef<number | null>(null);
  const observerRef = useRef<MutationObserver | null>(null);
  const knownNodesRef = useRef(new Map<string, Element>());
  currentTick = state.tick;

  useEffect(() => {
    // Sampling straight inside rAF reads layout BEFORE this frame's ResizeObserver scroll
    // compensation runs, counting states that never reach the screen. The nested timeout runs
    // after the frame paints, so only reader-visible positions are measured.
    const rafLoop = () => {
      window.setTimeout(() => {
        const node = scroller();
        if (node && timerRef.current !== null) {
          metrics.frameSamples += 1;
          const distance = distanceFromBottom(node);
          if (distance > 2) {
            metrics.bounceFrames += 1;
            metrics.maxBounce = Math.max(metrics.maxBounce, distance);
            const sizer = node.querySelector<HTMLElement>(':scope > div:nth-child(2)');
            const rowRects = [...node.querySelectorAll<HTMLElement>('[data-vl-key]')].map((row) =>
              row.getBoundingClientRect()
            );
            const nodeTop = node.getBoundingClientRect().top - node.scrollTop;
            const lastRowBottom = Math.max(...rowRects.map((rect) => rect.bottom - nodeTop), 0);
            metrics.bounceLog.push({
              distance: Math.round(distance),
              tick: currentTick,
              phase: currentTick % 7,
              rows: rowRects.length,
              scrollHeight: node.scrollHeight,
              sizerHeight: sizer ? Math.round(sizer.getBoundingClientRect().height) : -1,
              sizerTop: sizer ? Math.round(sizer.getBoundingClientRect().top - nodeTop) : -1,
              lastRowBottom: Math.round(lastRowBottom)
            });
          }
        }
      }, 0);
      frame = requestAnimationFrame(rafLoop);
    };
    let frame = requestAnimationFrame(rafLoop);
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const node = scroller();
    if (!node || observerRef.current) return;
    const observer = new MutationObserver(() => {
      const next = rowByIndex();
      const viewport = scroller()?.getBoundingClientRect();
      for (const [index, element] of next) {
        const previous = knownNodesRef.current.get(index);
        if (previous && previous !== element && previous.isConnected === false) {
          metrics.remountEvents += 1;
          const rect = element.getBoundingClientRect();
          metrics.remountDetails.push({
            index,
            visible: viewport ? rect.bottom > viewport.top && rect.top < viewport.bottom : false,
            key: (element.textContent ?? '').slice(0, 60)
          });
        }
      }
      knownNodesRef.current = next;
    });
    observer.observe(node, { childList: true, subtree: true });
    observerRef.current = observer;
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  });

  useEffect(() => {
    window.streamHarness = {
      start: () => {
        if (timerRef.current !== null) return;
        timerRef.current = window.setInterval(() => setState(advance), 60);
      },
      stop: () => {
        if (timerRef.current === null) return;
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      },
      metrics: () => ({
        ...metrics,
        tick: currentTick,
        rowCount: document.querySelectorAll('[role="log"] [data-index]').length
      }),
      scrollUpBy: (px: number) => {
        const node = scroller();
        if (node) node.scrollTop -= px;
      },
      anchor: () => {
        const node = scroller();
        if (!node) return { id: null };
        const rows = [...document.querySelectorAll<HTMLElement>('[role="log"] [data-index]')];
        const target = rows.find((row) => row.getBoundingClientRect().top >= node.getBoundingClientRect().top + 4);
        if (!target) return { id: null };
        anchorRef = {
          key: target.getAttribute('data-index') ?? '',
          top: target.getBoundingClientRect().top
        };
        return { id: anchorRef.key };
      },
      anchorDrift: () => {
        if (!anchorRef) return 0;
        const target = document.querySelector<HTMLElement>(`[role="log"] [data-index="${anchorRef.key}"]`);
        if (!target) return Number.NaN;
        return target.getBoundingClientRect().top - anchorRef.top;
      },
      state: () => {
        const node = scroller();
        return {
          distanceFromBottom: node ? distanceFromBottom(node) : Number.NaN,
          scrollTop: node?.scrollTop ?? Number.NaN
        };
      }
    };
  });

  const stream: MeshAgentStreamView = {
    id: 'mesh_stress',
    agentName: 'Codex',
    provider: 'codex',
    tag: 'Agent',
    status: 'running',
    output: '',
    items: agentObservationCards(state.events, 'codex')
  };

  return (
    <div style={{ height: '100vh', display: 'flex' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <MeshAgentObservationPanel
          agentName="Codex"
          stream={stream}
        />
      </div>
    </div>
  );
}

const rootElement = document.getElementById('root');
if (rootElement) createRoot(rootElement).render(<Harness />);
