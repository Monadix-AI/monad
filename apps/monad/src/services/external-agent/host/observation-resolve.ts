import type {
  AgentObservationEvent,
  ExternalAgentConnectionSnapshot,
  ExternalAgentConvenienceFrame,
  ExternalAgentObservationAccessResponse,
  ExternalAgentRawFrame,
  ExternalAgentSessionId,
  ExternalAgentUiObservationFrame
} from '@monad/protocol';
import type { ExternalAgentHostDeps, LiveExternalAgentSession } from '#/services/external-agent/host/host-types.ts';

import { toAgentObservationEvent } from '@monad/atoms/agent-observation';
import { externalAgentUsageLimitMeter } from '@monad/atoms/external-agent-observation';
import { EXTERNAL_AGENT_OUTPUT_SNAPSHOT_MAX } from '@monad/protocol';

import {
  providerHistoryEventsFromLocal,
  providerHistoryPageViaCli
} from '#/services/external-agent/host/history-backfill.ts';
import { encodeProviderHistoryCursor } from '#/services/external-agent/host/history-cursor.ts';
import {
  convenienceFramesFromEvents,
  liveRowsToRawFrames,
  readyFrame
} from '#/services/external-agent/host/observation-dual.ts';
import { getExternalAgentProviderAdapter } from '#/services/external-agent/index.ts';
import { liveRawRowsOutput } from '#/services/external-agent/live-raw-store.ts';

export type ExternalAgentRawObservationResult =
  | { state: 'live'; observationEpoch: string; frames: ExternalAgentRawFrame[] }
  | { state: 'unavailable'; reason: string };

export type ExternalAgentConvenienceObservationResult =
  | { state: 'live'; observationEpoch: string; frames: ExternalAgentConvenienceFrame[] }
  | { state: 'unavailable'; reason: string };

export interface ExternalAgentObservationResolveContext {
  live: Map<string, LiveExternalAgentSession>;
  store: ExternalAgentHostDeps['store'];
  agents: ExternalAgentHostDeps['agents'];
  buildSpawnEnv(env?: Record<string, string>): Promise<Record<string, string>>;
  takeStructuredLines(id: string, stream: 'stdout' | 'stderr', chunk: string): string;
  dropStructuredBuffer(id: string): void;
}

const LIVE_OBSERVATION_PAGE_ROWS = 2_000;

/** Resolves a session from the ephemeral live store or the provider's own history. */
export class ExternalAgentObservationResolver {
  constructor(private readonly ctx: ExternalAgentObservationResolveContext) {}

  observe(id: string, afterSeq?: number): ExternalAgentObservationAccessResponse {
    const live = this.ctx.live.get(id);
    if (live?.liveRawStore && !live.suspended) {
      if (afterSeq !== undefined) {
        const page = live.liveRawStore.page({
          after: afterSeq,
          limit: LIVE_OBSERVATION_PAGE_ROWS,
          maxBytes: EXTERNAL_AGENT_OUTPUT_SNAPSHOT_MAX,
          sortDirection: 'asc'
        });
        const last = page.rows.at(-1);
        return {
          state: 'live',
          externalAgentSessionId: id as ExternalAgentSessionId,
          provider: live.provider,
          observationEpoch: live.observationEpoch,
          ...(live.providerHistoryCheckpoint ? { providerHistoryCheckpoint: live.providerHistoryCheckpoint } : {}),
          append: liveRawRowsOutput(page.rows),
          seq: last?.seq ?? afterSeq,
          observedAt: last?.observedAt ?? new Date().toISOString()
        };
      }
      const page = live.liveRawStore.page({
        limit: LIVE_OBSERVATION_PAGE_ROWS,
        maxBytes: EXTERNAL_AGENT_OUTPUT_SNAPSHOT_MAX,
        sortDirection: 'desc'
      });
      const snapshot = liveRawRowsOutput(page.rows);
      const first = page.rows[0];
      const last = page.rows.at(-1);
      return {
        state: 'live',
        externalAgentSessionId: id as ExternalAgentSessionId,
        provider: live.provider,
        observationEpoch: live.observationEpoch,
        ...(live.providerHistoryCheckpoint ? { providerHistoryCheckpoint: live.providerHistoryCheckpoint } : {}),
        output: snapshot,
        events: live.adapter.events.projectLive({ id, output: snapshot }).events,
        ...(page.nextBefore !== undefined && first
          ? { historyBefore: live.liveRawStore.cursorBefore(first.seq) }
          : live.providerSessionRef
            ? { historyBefore: encodeProviderHistoryCursor('') }
            : {}),
        usageMeter: externalAgentUsageLimitMeter({ adapter: live.adapter, output: snapshot }),
        seq: last?.seq ?? 0,
        observedAt: last?.observedAt ?? new Date().toISOString()
      };
    }
    const row = this.ctx.store.getExternalAgentSession(id);
    if (!row) {
      return {
        state: 'unavailable',
        externalAgentSessionId: id as ExternalAgentSessionId,
        reason: 'external agent session not found'
      };
    }
    return {
      state: 'unavailable',
      externalAgentSessionId: id as ExternalAgentSessionId,
      provider: row.provider,
      reason: 'provider history unavailable'
    };
  }

  /** The raw plane: exact accepted transport frames for the connected epoch, after `afterSeq`. Each
   *  frame's `data` is the verbatim provider payload — no projection, merge, or dedupe. */
  observeRaw(id: string, afterSeq?: number): ExternalAgentRawObservationResult {
    const live = this.ctx.live.get(id);
    if (!live?.liveRawStore || live.suspended) {
      const row = this.ctx.store.getExternalAgentSession(id);
      return {
        state: 'unavailable',
        reason: row ? 'provider history unavailable' : 'external agent session not found'
      };
    }
    const page = live.liveRawStore.page({
      ...(afterSeq !== undefined ? { after: afterSeq } : {}),
      limit: LIVE_OBSERVATION_PAGE_ROWS,
      maxBytes: EXTERNAL_AGENT_OUTPUT_SNAPSHOT_MAX,
      sortDirection: 'asc'
    });
    return {
      state: 'live',
      observationEpoch: live.observationEpoch,
      frames: liveRowsToRawFrames(
        {
          externalAgentSessionId: id as ExternalAgentSessionId,
          provider: live.provider,
          observationEpoch: live.observationEpoch
        },
        page.rows
      )
    };
  }

  /** The convenience plane: the neutral event list for the connected epoch, delivered as a `ready`
   *  frame (epoch + history boundary) followed by one `upsert` per projected event. Same projection
   *  as `observeUi`, but incremental frames a consumer merges rather than a wholesale replacement. */
  observeConvenience(id: string): ExternalAgentConvenienceObservationResult {
    const live = this.ctx.live.get(id);
    if (!live?.liveRawStore || live.suspended) {
      const row = this.ctx.store.getExternalAgentSession(id);
      return {
        state: 'unavailable',
        reason: row ? 'provider history unavailable' : 'external agent session not found'
      };
    }
    const page = live.liveRawStore.page({
      limit: LIVE_OBSERVATION_PAGE_ROWS,
      maxBytes: EXTERNAL_AGENT_OUTPUT_SNAPSHOT_MAX,
      sortDirection: 'desc'
    });
    const snapshot = liveRawRowsOutput(page.rows);
    const first = page.rows[0];
    const historyBefore =
      page.nextBefore !== undefined && first
        ? live.liveRawStore.cursorBefore(first.seq)
        : live.providerSessionRef
          ? encodeProviderHistoryCursor('')
          : undefined;
    const events = live.adapter.events
      .projectLive({ id, output: snapshot })
      .events.map((event) => toAgentObservationEvent(event, live.adapter.observation))
      .filter((event): event is AgentObservationEvent => event !== null);
    return {
      state: 'live',
      observationEpoch: live.observationEpoch,
      frames: [readyFrame(live.observationEpoch, historyBefore), ...convenienceFramesFromEvents(events)]
    };
  }

  /** The race-free bootstrap handshake for the Observation panel: the connected epoch + history/live
   *  boundary and a monotonic `revision` (the live output cursor) so a subscribe-then-refetch client can
   *  reconcile against control lifecycle events without assuming arrival order. */
  connectionSnapshot(id: string): ExternalAgentConnectionSnapshot {
    const live = this.ctx.live.get(id);
    if (live?.liveRawStore && !live.suspended) {
      const page = live.liveRawStore.page({
        limit: LIVE_OBSERVATION_PAGE_ROWS,
        maxBytes: EXTERNAL_AGENT_OUTPUT_SNAPSHOT_MAX,
        sortDirection: 'desc'
      });
      const first = page.rows[0];
      const last = page.rows.at(-1);
      const historyBefore =
        page.nextBefore !== undefined && first
          ? live.liveRawStore.cursorBefore(first.seq)
          : live.providerSessionRef
            ? encodeProviderHistoryCursor('')
            : undefined;
      return {
        state: 'connected',
        externalAgentSessionId: id as ExternalAgentSessionId,
        provider: live.provider,
        observationEpoch: live.observationEpoch,
        ...(historyBefore ? { historyBefore } : {}),
        revision: last?.seq ?? 0
      };
    }
    const row = this.ctx.store.getExternalAgentSession(id);
    return {
      state: 'disconnected',
      externalAgentSessionId: id as ExternalAgentSessionId,
      ...(row ? { provider: row.provider } : {}),
      revision: 0
    };
  }

  /** The neutral UI plane: the full projected event list for the session's current output, re-derived
   *  from the whole snapshot every call (never a delta), so a consumer replaces its list wholesale. */
  observeUi(id: string): ExternalAgentUiObservationFrame {
    const live = this.ctx.live.get(id);
    if (live?.liveRawStore && !live.suspended) {
      const page = live.liveRawStore.page({
        limit: LIVE_OBSERVATION_PAGE_ROWS,
        maxBytes: EXTERNAL_AGENT_OUTPUT_SNAPSHOT_MAX,
        sortDirection: 'desc'
      });
      const snapshot = liveRawRowsOutput(page.rows);
      const first = page.rows[0];
      const last = page.rows.at(-1);
      return {
        state: 'live',
        externalAgentSessionId: id as ExternalAgentSessionId,
        provider: live.provider,
        observationEpoch: live.observationEpoch,
        ...(live.providerHistoryCheckpoint ? { providerHistoryCheckpoint: live.providerHistoryCheckpoint } : {}),
        events: live.adapter.events
          .projectLive({ id, output: snapshot })
          .events.map((event) => toAgentObservationEvent(event, live.adapter.observation))
          .filter((event) => event !== null),
        ...(page.nextBefore !== undefined && first
          ? { historyBefore: live.liveRawStore.cursorBefore(first.seq) }
          : live.providerSessionRef
            ? { historyBefore: encodeProviderHistoryCursor('') }
            : {}),
        seq: last?.seq ?? 0,
        observedAt: last?.observedAt ?? new Date().toISOString()
      };
    }
    const row = this.ctx.store.getExternalAgentSession(id);
    if (!row) {
      return {
        state: 'unavailable',
        externalAgentSessionId: id as ExternalAgentSessionId,
        reason: 'external agent session not found'
      };
    }
    return {
      state: 'unavailable',
      externalAgentSessionId: id as ExternalAgentSessionId,
      provider: row.provider,
      reason: 'provider history unavailable'
    };
  }

  async observeWithProviderHistory(id: string): Promise<ExternalAgentObservationAccessResponse> {
    const base = this.observe(id);
    if (base.state === 'live') return base;
    if (
      base.state === 'history' &&
      base.events?.some((event) => event.projection !== 'unknown' && event.role !== 'system')
    )
      return base;
    const row = this.ctx.store.getExternalAgentSession(id);
    if (!row?.providerSessionRef) return base;
    const adapter = getExternalAgentProviderAdapter(row.provider);
    const cliPage = await providerHistoryPageViaCli(
      row,
      adapter,
      { limit: 100, sortDirection: 'desc' },
      {
        agents: this.ctx.agents,
        buildSpawnEnv: (env) => this.ctx.buildSpawnEnv(env),
        takeStructuredLines: (structuredId, stream, chunk) => this.ctx.takeStructuredLines(structuredId, stream, chunk),
        dropStructuredBuffer: (structuredId) => this.ctx.dropStructuredBuffer(structuredId)
      }
    ).catch(() => null);
    if (cliPage?.state === 'available' && cliPage.events.length > 0) {
      return {
        state: 'history',
        externalAgentSessionId: id as ExternalAgentSessionId,
        provider: row.provider,
        output: cliPage.events.map((event) => event.text).join('\n'),
        events: cliPage.events,
        ...(cliPage.nextCursor ? { historyBefore: encodeProviderHistoryCursor(cliPage.nextCursor) } : {}),
        usageMeter: null,
        observedAt: row.updatedAt
      };
    }
    const localEvents = await providerHistoryEventsFromLocal(row, adapter);
    if (localEvents) {
      return {
        state: 'history',
        externalAgentSessionId: id as ExternalAgentSessionId,
        provider: row.provider,
        output: localEvents.map((event) => event.text).join('\n'),
        events: localEvents,
        usageMeter: null,
        observedAt: row.updatedAt
      };
    }
    return base;
  }

  async observeUiWithProviderHistory(id: string): Promise<ExternalAgentUiObservationFrame> {
    const live = this.observeUi(id);
    if (live.state === 'live') return live;
    const access = await this.observeWithProviderHistory(id);
    if (access.state === 'unavailable') return access;
    const row = this.ctx.store.getExternalAgentSession(id);
    const adapter = getExternalAgentProviderAdapter(access.provider);
    return {
      state: 'history',
      externalAgentSessionId: id as ExternalAgentSessionId,
      provider: access.provider,
      events: (access.events ?? [])
        .map((event) => toAgentObservationEvent(event, adapter.observation))
        .filter((event) => event !== null),
      ...(access.historyBefore ? { historyBefore: access.historyBefore } : {}),
      observedAt: access.observedAt ?? row?.updatedAt ?? new Date().toISOString()
    };
  }
}
