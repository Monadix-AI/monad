import type { Logger } from '@monad/logger';
import type {
  AgentObservationEvent,
  MeshAgentObservationEvent,
  MeshConnectionSnapshot,
  MeshConvenienceFrame,
  MeshRawEvent,
  MeshSessionId,
  ObservationCursor
} from '@monad/protocol';
import type { LiveMeshSession, MeshAgentHostDeps } from '#/services/mesh-agent/host/host-types.ts';
import type { LiveRawRow } from '#/services/mesh-agent/live-raw-store.ts';

import { MESH_AGENT_OUTPUT_SNAPSHOT_MAX } from '@monad/protocol';
import { toFallbackAgentObservationEvent } from '@monad/sdk-atom';

import { diffObservationEvents } from '#/services/mesh-agent/host/convenience-projection.ts';
import { encodeEventCursor } from '#/services/mesh-agent/host/event-cursor.ts';
import {
  conveniencePatchFrame,
  liveObservationCursor,
  liveRowsToRawFrames,
  readyFrame
} from '#/services/mesh-agent/host/observation-dual.ts';

export type MeshAgentRawObservationResult =
  | { state: 'live'; observationEpoch: string; frames: MeshRawEvent[] }
  | { state: 'unavailable'; reason: string };

export type MeshAgentConvenienceObservationResult =
  | { state: 'live'; observationEpoch: string; frames: MeshConvenienceFrame[] }
  | { state: 'unavailable'; reason: string };

interface MeshAgentObservationResolveContext {
  live: Map<string, LiveMeshSession>;
  log: Logger;
  store: MeshAgentHostDeps['store'];
}

const LIVE_OBSERVATION_PAGE_ROWS = 2_000;

interface RetainedConvenienceProjection {
  epoch: string;
  providerSessionRef?: string;
  seq: number;
  events: AgentObservationEvent[];
  eventsBefore?: ObservationCursor;
  projector: { advance(output: string): { events: MeshAgentObservationEvent[] } };
}

interface ConvenienceProjectionAdvance {
  state: RetainedConvenienceProjection;
  previousSeq: number;
  previousEvents: AgentObservationEvent[];
}

class ConvenienceProjectionRowError extends Error {
  constructor(
    readonly row: LiveRawRow,
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ConvenienceProjectionRowError';
  }
}

function serializeProjectionError(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { value: String(error) };
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...(depth < 2 && error.cause !== undefined ? { cause: serializeProjectionError(error.cause, depth + 1) } : {})
  };
}

/** Resolves a session from the ephemeral live store or the adapter's earlier-event source. */
export class MeshAgentObservationResolver {
  private readonly convenienceProjections = new WeakMap<LiveMeshSession, RetainedConvenienceProjection>();

  constructor(private readonly ctx: MeshAgentObservationResolveContext) {}

  /** The raw plane: exact accepted transport frames for the connected epoch. A fresh observer receives
   *  the newest committed window; a resumed observer receives rows after `afterSeq`. Each frame's `data`
   *  is the verbatim provider payload — no projection, merge, or dedupe. */
  observeRaw(id: string, afterSeq?: number): MeshAgentRawObservationResult {
    const live = this.ctx.live.get(id);
    if (!live?.liveRawStore) {
      const row = this.ctx.store.getMeshSession(id);
      return {
        state: 'unavailable',
        reason: row ? 'provider events unavailable' : 'MeshAgent session not found'
      };
    }
    const page = live.liveRawStore.page(
      afterSeq === undefined
        ? {
            limit: LIVE_OBSERVATION_PAGE_ROWS,
            maxBytes: MESH_AGENT_OUTPUT_SNAPSHOT_MAX,
            sortDirection: 'desc'
          }
        : {
            after: afterSeq,
            limit: LIVE_OBSERVATION_PAGE_ROWS,
            maxBytes: MESH_AGENT_OUTPUT_SNAPSHOT_MAX,
            sortDirection: 'asc'
          }
    );
    return {
      state: 'live',
      observationEpoch: live.observationEpoch,
      frames: liveRowsToRawFrames(
        {
          meshSessionId: id as MeshSessionId,
          provider: live.provider,
          observationEpoch: live.observationEpoch
        },
        page.rows
      )
    };
  }

  private createConvenienceProjector(live: LiveMeshSession, id: string) {
    const incremental = live.adapter.events.createLiveProjector?.({
      id,
      ...(live.providerSessionRef ? { providerSessionRef: live.providerSessionRef } : {})
    });
    if (incremental) return incremental;
    let output = '';
    return {
      advance: (delta: string, observedAt?: string) => {
        output += delta;
        const projected = live.adapter.events.projectLive({
          id,
          output,
          ...(observedAt ? { observedAt } : {}),
          ...(live.providerSessionRef ? { providerSessionRef: live.providerSessionRef } : {})
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

  private advanceConvenienceRows(
    projector: ReturnType<MeshAgentObservationResolver['createConvenienceProjector']>,
    rows: LiveRawRow[]
  ) {
    let page = { events: [] } as ReturnType<typeof projector.advance>;
    for (const row of rows) {
      if (row.stream === 'stderr') continue;
      try {
        page = projector.advance(row.payload, row.observedAt);
      } catch (error) {
        throw new ConvenienceProjectionRowError(row, error);
      }
    }
    return page;
  }

  private toConvenienceEvents(live: LiveMeshSession, events: MeshAgentObservationEvent[]) {
    const runtime = live.adapter.observationRuntime;
    return events
      .map((event) =>
        runtime
          ? runtime.toAgentObservationEvent(event)
          : toFallbackAgentObservationEvent(event, live.adapter.observation)
      )
      .filter((event): event is AgentObservationEvent => event !== null);
  }

  private replayConvenienceThrough(live: LiveMeshSession, id: string, throughSeq: number) {
    if (!live.liveRawStore || throughSeq <= 0) return [];
    const page = live.liveRawStore.page({
      before: throughSeq + 1,
      limit: LIVE_OBSERVATION_PAGE_ROWS,
      maxBytes: MESH_AGENT_OUTPUT_SNAPSHOT_MAX,
      sortDirection: 'desc'
    });
    const projector = this.createConvenienceProjector(live, id);
    return this.toConvenienceEvents(live, this.advanceConvenienceRows(projector, page.rows).events);
  }

  private advanceConvenienceProjection(live: LiveMeshSession, id: string): ConvenienceProjectionAdvance {
    let state = this.convenienceProjections.get(live);
    if (!state || state.epoch !== live.observationEpoch || state.providerSessionRef !== live.providerSessionRef) {
      const page = live.liveRawStore.page({
        limit: LIVE_OBSERVATION_PAGE_ROWS,
        maxBytes: MESH_AGENT_OUTPUT_SNAPSHOT_MAX,
        sortDirection: 'desc'
      });
      const projector = this.createConvenienceProjector(live, id);
      state = {
        epoch: live.observationEpoch,
        ...(live.providerSessionRef ? { providerSessionRef: live.providerSessionRef } : {}),
        seq: page.rows.at(-1)?.seq ?? 0,
        events:
          page.rows.length === 0
            ? []
            : this.toConvenienceEvents(live, this.advanceConvenienceRows(projector, page.rows).events),
        ...(page.nextBefore !== undefined && page.rows[0]
          ? { eventsBefore: liveObservationCursor(live.observationEpoch, page.rows[0].seq) }
          : {}),
        projector
      };
      this.convenienceProjections.set(live, state);
      return { state, previousSeq: 0, previousEvents: [] as AgentObservationEvent[] };
    }

    const previousSeq = state.seq;
    const previousEvents = state.events;
    try {
      while (true) {
        const page = live.liveRawStore.page({
          after: state.seq,
          limit: LIVE_OBSERVATION_PAGE_ROWS,
          maxBytes: MESH_AGENT_OUTPUT_SNAPSHOT_MAX,
          sortDirection: 'asc'
        });
        const last = page.rows.at(-1);
        if (!last) break;
        state.events = this.toConvenienceEvents(live, this.advanceConvenienceRows(state.projector, page.rows).events);
        state.seq = last.seq;
      }
      return { state, previousSeq, previousEvents };
    } catch (error) {
      this.convenienceProjections.delete(live);
      throw error;
    }
  }

  /** The convenience plane: a `ready` handshake (epoch, resume anchor, earlier-events boundary) followed by
   *  at most ONE atomic patch carrying every projected change since `afterSeq`. A later raw row can
   *  still mutate an earlier event, so "what changed" is a diff between two projections, never the
   *  tail of one — see convenience-projection.ts. */
  observeConvenience(id: string, afterSeq?: number): MeshAgentConvenienceObservationResult {
    const live = this.ctx.live.get(id);
    if (!live?.liveRawStore) {
      const row = this.ctx.store.getMeshSession(id);
      return {
        state: 'unavailable',
        reason: row ? 'provider events unavailable' : 'MeshAgent session not found'
      };
    }
    const retainedProjection = this.convenienceProjections.get(live);
    const projectionPhase =
      !retainedProjection ||
      retainedProjection.epoch !== live.observationEpoch ||
      retainedProjection.providerSessionRef !== live.providerSessionRef
        ? 'rebuild'
        : 'incremental';
    let projection: ConvenienceProjectionAdvance;
    try {
      projection = this.advanceConvenienceProjection(live, id);
    } catch (error) {
      const failedRow = error instanceof ConvenienceProjectionRowError ? error.row : undefined;
      this.ctx.log.error(
        {
          event: 'mesh.convenience_projection_failed',
          sessionId: live.transcriptTargetId,
          meshSessionId: id,
          agentName: live.agentName,
          runtimeRole: live.runtimeRole,
          provider: live.provider,
          adapterProvider: live.adapter.provider,
          observationEpoch: live.observationEpoch,
          providerSessionRef: live.providerSessionRef,
          afterSeq: afterSeq ?? 0,
          revision: live.outputSeq,
          projectionPhase,
          projectorMode: live.adapter.events.createLiveProjector ? 'incremental' : 'snapshot',
          hasObservationRuntime: Boolean(live.adapter.observationRuntime),
          retainedProjection: retainedProjection
            ? {
                epoch: retainedProjection.epoch,
                providerSessionRef: retainedProjection.providerSessionRef,
                seq: retainedProjection.seq,
                eventCount: retainedProjection.events.length
              }
            : null,
          failingRawRow: failedRow
            ? {
                seq: failedRow.seq,
                stream: failedRow.stream,
                observedAt: failedRow.observedAt,
                payloadBytes: Buffer.byteLength(failedRow.payload),
                payloadSha256: new Bun.CryptoHasher('sha256').update(failedRow.payload).digest('hex')
              }
            : null,
          err: serializeProjectionError(error)
        },
        'native cli convenience observation projection failed'
      );
      return {
        state: 'live',
        observationEpoch: live.observationEpoch,
        frames: [
          readyFrame(
            live.observationEpoch,
            live.providerSessionRef ? encodeEventCursor('') : undefined,
            liveObservationCursor(live.observationEpoch, afterSeq ?? 0)
          )
        ]
      };
    }
    const { state: current, previousSeq, previousEvents } = projection;
    const baselineEvents =
      afterSeq === undefined
        ? []
        : afterSeq === previousSeq
          ? previousEvents
          : afterSeq === current.seq
            ? current.events
            : this.replayConvenienceThrough(live, id, Math.min(afterSeq, current.seq));
    const operations = diffObservationEvents(baselineEvents, current.events);
    const eventsBefore = current.eventsBefore ?? (live.providerSessionRef ? encodeEventCursor('') : undefined);
    const readySeq = Math.min(afterSeq ?? 0, current.seq);
    const readyCursor = liveObservationCursor(live.observationEpoch, readySeq);
    const patchCursor = current.seq > readySeq ? liveObservationCursor(live.observationEpoch, current.seq) : undefined;
    const patch = patchCursor ? conveniencePatchFrame(patchCursor, operations) : undefined;
    return {
      state: 'live',
      observationEpoch: live.observationEpoch,
      frames: [readyFrame(live.observationEpoch, eventsBefore, readyCursor), ...(patch ? [patch] : [])]
    };
  }

  /** The race-free bootstrap handshake for the Observation panel: the connected epoch + events/live
   *  boundary and a monotonic `revision` (the live output cursor) so a subscribe-then-refetch client can
   *  reconcile against control lifecycle events without assuming arrival order. */
  connectionSnapshot(id: string): MeshConnectionSnapshot {
    const live = this.ctx.live.get(id);
    if (live?.liveRawStore) {
      const page = live.liveRawStore.page({
        limit: LIVE_OBSERVATION_PAGE_ROWS,
        maxBytes: MESH_AGENT_OUTPUT_SNAPSHOT_MAX,
        sortDirection: 'desc'
      });
      const first = page.rows[0];
      const last = page.rows.at(-1);
      const eventsBefore =
        page.nextBefore !== undefined && first
          ? live.liveRawStore.cursorBefore(first.seq)
          : live.providerSessionRef
            ? encodeEventCursor('')
            : undefined;
      return {
        state: 'connected',
        meshSessionId: id as MeshSessionId,
        provider: live.provider,
        observationEpoch: live.observationEpoch,
        ...(eventsBefore ? { eventsBefore } : {}),
        revision: last?.seq ?? 0
      };
    }
    const row = this.ctx.store.getMeshSession(id);
    return {
      state: 'disconnected',
      meshSessionId: id as MeshSessionId,
      ...(row ? { provider: row.provider } : {}),
      revision: 0
    };
  }
}
