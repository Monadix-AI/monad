import type {
  MeshAgentProvider,
  MeshConvenienceFrame,
  MeshConvenienceOperation,
  MeshRawEvent,
  MeshSessionId,
  ObservationCursor
} from '@monad/protocol';
import type { LiveRawRow } from '#/services/mesh-agent/live-raw-store.ts';

import { formatObservationCursor } from '@monad/protocol';

export interface RawFrameContext {
  meshSessionId: MeshSessionId;
  provider: MeshAgentProvider;
  observationEpoch: string;
}

// A live-raw-store row is exactly one accepted provider transport frame; its `payload` is preserved
// verbatim as the raw plane's `data` (no parse/merge) and its position becomes the ordering/resume
// cursor. The cursor carries the epoch, not a bare row sequence: sequences restart at 1 on every
// epoch rotation, so an epoch-less cursor cannot tell "after row 42 of this epoch" from "row 42 of a
// rotated one".
function liveRowToRawFrame(ctx: RawFrameContext, row: LiveRawRow): MeshRawEvent {
  return {
    meshSessionId: ctx.meshSessionId,
    provider: ctx.provider,
    observationEpoch: ctx.observationEpoch,
    origin: 'live',
    cursor: liveObservationCursor(ctx.observationEpoch, row.seq),
    stream: row.stream,
    data: row.payload,
    observedAt: row.observedAt
  };
}

export function liveRowsToRawFrames(ctx: RawFrameContext, rows: LiveRawRow[]): MeshRawEvent[] {
  return rows.map((row) => liveRowToRawFrame(ctx, row));
}

// One raw position can project to several operations. They travel as ONE patch because the SSE frame
// is the only unit SSE never splits: per-operation frames sharing a cursor would let a consumer that
// drops mid-batch resume at `> cursor` and silently lose the batch's remainder. `cursor` is the
// highest raw position the patch fully reflects.
export function conveniencePatchFrame(
  cursor: ObservationCursor,
  operations: MeshConvenienceOperation[]
): MeshConvenienceFrame | undefined {
  return operations.length > 0 ? { kind: 'patch', cursor, operations } : undefined;
}

export function readyFrame(
  observationEpoch?: string,
  eventsBefore?: ObservationCursor,
  cursor?: ObservationCursor
): MeshConvenienceFrame {
  return {
    kind: 'ready',
    ...(observationEpoch ? { observationEpoch } : {}),
    ...(cursor ? { cursor } : {}),
    ...(eventsBefore ? { eventsBefore } : {})
  };
}

export function liveObservationCursor(observationEpoch: string, seq: number): ObservationCursor {
  return formatObservationCursor({ kind: 'live', observationEpoch, seq });
}
