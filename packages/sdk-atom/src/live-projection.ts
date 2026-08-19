import type { AgentObservationEvent, MeshAgentObservationEvent } from '@monad/protocol';

import { toFallbackAgentObservationEvent } from './agent-observation.ts';

// The ONE live-plane projection pipeline. The daemon's convenience SSE resolver, its event pages,
// and the developer live-event-replay tool must all project raw provider rows through this exact
// path — the replay tool exists to debug the production pipeline, so a diverging projection there
// is a lie. Invariant carried by the incremental projector contract: a projected event may be
// UPDATED by later rows, never silently dropped.

type LiveProjectionEvents = {
  createLiveProjector?: (args: { id: string; providerSessionRef?: string }) => {
    advance(delta: string, observedAt?: string): { events: MeshAgentObservationEvent[] };
  };
  projectLive: (args: {
    id: string;
    output: string;
    observedAt?: string;
    providerSessionRef?: string;
    mode?: 'events' | 'live';
  }) => { events: MeshAgentObservationEvent[] };
};

export type LiveProjectionAdapter = {
  events: LiveProjectionEvents;
  observation?: Parameters<typeof toFallbackAgentObservationEvent>[1];
  observationRuntime?: { toAgentObservationEvent(event: MeshAgentObservationEvent): AgentObservationEvent | null };
};

export type LiveProjectionRow = { stream?: string; payload: string; observedAt?: string };

export function createConvenienceLiveProjector(
  adapter: LiveProjectionAdapter,
  args: { id: string; providerSessionRef?: string }
): { advance(delta: string, observedAt?: string): { events: MeshAgentObservationEvent[] } } {
  const incremental = adapter.events.createLiveProjector?.({
    id: args.id,
    ...(args.providerSessionRef ? { providerSessionRef: args.providerSessionRef } : {})
  });
  if (incremental) return incremental;
  let output = '';
  return {
    advance: (delta: string, observedAt?: string) => {
      output += delta;
      const projected = adapter.events.projectLive({
        id: args.id,
        output,
        ...(observedAt ? { observedAt } : {}),
        ...(args.providerSessionRef ? { providerSessionRef: args.providerSessionRef } : {})
      });
      return {
        ...projected,
        events: projected.events.map((event) =>
          event.createdAt || !observedAt ? event : { ...event, createdAt: observedAt }
        )
      };
    }
  };
}

export function advanceConvenienceRows(
  projector: ReturnType<typeof createConvenienceLiveProjector>,
  rows: readonly LiveProjectionRow[],
  wrapRowError?: (row: LiveProjectionRow, cause: unknown) => Error
): { events: MeshAgentObservationEvent[] } {
  let page: { events: MeshAgentObservationEvent[] } = { events: [] };
  for (const row of rows) {
    if (row.stream === 'stderr') continue;
    try {
      page = projector.advance(row.payload, row.observedAt);
    } catch (error) {
      throw wrapRowError ? wrapRowError(row, error) : error;
    }
  }
  return page;
}

export function toConvenienceEvents(
  adapter: LiveProjectionAdapter,
  events: readonly MeshAgentObservationEvent[]
): AgentObservationEvent[] {
  const runtime = adapter.observationRuntime;
  return events
    .map((event) =>
      runtime ? runtime.toAgentObservationEvent(event) : toFallbackAgentObservationEvent(event, adapter.observation)
    )
    .filter((event): event is AgentObservationEvent => event !== null);
}

export function projectConvenienceRows(
  adapter: LiveProjectionAdapter,
  args: { id: string; providerSessionRef?: string; rows: readonly LiveProjectionRow[] }
): AgentObservationEvent[] {
  const projector = createConvenienceLiveProjector(adapter, args);
  return toConvenienceEvents(adapter, advanceConvenienceRows(projector, args.rows).events);
}
