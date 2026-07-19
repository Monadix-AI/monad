import type {
  AgentObservationEvent,
  ExternalAgentConvenienceFrame,
  ExternalAgentProvider,
  ExternalAgentRawFrame,
  ExternalAgentSessionId
} from '@monad/protocol';
import type { LiveRawRow } from '#/services/external-agent/live-raw-store.ts';

export interface RawFrameContext {
  externalAgentSessionId: ExternalAgentSessionId;
  provider: ExternalAgentProvider;
  observationEpoch: string;
}

// A live-raw-store row is exactly one accepted provider transport frame; its `payload` is preserved
// verbatim as the raw plane's `data` (no parse/merge) and its `seq` becomes the ordering/resume cursor.
function liveRowToRawFrame(ctx: RawFrameContext, row: LiveRawRow): ExternalAgentRawFrame {
  return {
    externalAgentSessionId: ctx.externalAgentSessionId,
    provider: ctx.provider,
    observationEpoch: ctx.observationEpoch,
    origin: 'live',
    cursor: String(row.seq),
    stream: row.stream,
    data: row.payload,
    observedAt: row.observedAt
  };
}

export function liveRowsToRawFrames(ctx: RawFrameContext, rows: LiveRawRow[]): ExternalAgentRawFrame[] {
  return rows.map((row) => liveRowToRawFrame(ctx, row));
}

// Convenience is incremental upserts of the neutral event, not a full list per tick. The cursor keys
// the merged timeline item; it defaults to the event id (stable across a streaming item's deltas) and
// can be overridden to tie into the raw seq when the caller has it.
export function convenienceFramesFromEvents(
  events: AgentObservationEvent[],
  cursorOf: (event: AgentObservationEvent, index: number) => string = (event) => event.id
): ExternalAgentConvenienceFrame[] {
  return events.map((event, index) => ({ kind: 'upsert', cursor: cursorOf(event, index), event }));
}

export function readyFrame(observationEpoch?: string, historyBefore?: string): ExternalAgentConvenienceFrame {
  return {
    kind: 'ready',
    ...(observationEpoch ? { observationEpoch } : {}),
    ...(historyBefore ? { historyBefore } : {})
  };
}
