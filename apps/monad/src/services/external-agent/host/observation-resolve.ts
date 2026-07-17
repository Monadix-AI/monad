import type {
  ExternalAgentObservationAccessResponse,
  ExternalAgentSessionId,
  ExternalAgentUiObservationFrame
} from '@monad/protocol';
import type { ExternalAgentHostDeps, LiveExternalAgentSession } from '#/services/external-agent/host/host-types.ts';

import {
  externalAgentNeutralStreamItems,
  externalAgentStreamItems,
  externalAgentUsageLimitMeter
} from '@monad/atoms/external-agent-observation';

import {
  providerHistoryOutputFromLocal,
  providerHistoryOutputViaCli
} from '#/services/external-agent/host/history-backfill.ts';
import { isManagedProjectRuntime } from '#/services/external-agent/host/host-helpers.ts';
import { getExternalAgentProviderAdapter } from '#/services/external-agent/index.ts';

export interface ExternalAgentObservationResolveContext {
  live: Map<string, LiveExternalAgentSession>;
  store: ExternalAgentHostDeps['store'];
  agents: ExternalAgentHostDeps['agents'];
  buildSpawnEnv(env?: Record<string, string>): Promise<Record<string, string>>;
  takeStructuredLines(id: string, stream: 'stdout' | 'stderr', chunk: string): string;
  dropStructuredBuffer(id: string): void;
}

/** Resolves a session's current observable state — from the live output buffer, the durable
 *  snapshot column, or (for managed-project runtimes) the provider's own history — independent of
 *  the subscription/publish side owned by `ExternalAgentObservationHub`. */
export class ExternalAgentObservationResolver {
  constructor(private readonly ctx: ExternalAgentObservationResolveContext) {}

  observe(id: string, afterSeq?: number): ExternalAgentObservationAccessResponse {
    const live = this.ctx.live.get(id);
    if (live) {
      const snapshot = live.outputBuffer.snapshot();
      // Resume: if the caller's cursor is still within the bounded tail, hand back only the delta
      // beyond it instead of the whole snapshot (a reconnecting client backfills from last-event-id).
      if (afterSeq !== undefined && live.outputSeq > afterSeq && live.outputSeq - afterSeq <= snapshot.length) {
        return {
          state: 'live',
          externalAgentSessionId: id as ExternalAgentSessionId,
          provider: live.provider,
          observationEpoch: live.observationEpoch,
          ...(live.providerHistoryCheckpoint ? { providerHistoryCheckpoint: live.providerHistoryCheckpoint } : {}),
          append: snapshot.slice(snapshot.length - (live.outputSeq - afterSeq)),
          seq: live.outputSeq,
          observedAt: new Date().toISOString()
        };
      }
      return {
        state: 'live',
        externalAgentSessionId: id as ExternalAgentSessionId,
        provider: live.provider,
        observationEpoch: live.observationEpoch,
        ...(live.providerHistoryCheckpoint ? { providerHistoryCheckpoint: live.providerHistoryCheckpoint } : {}),
        output: snapshot,
        events: externalAgentStreamItems({ id, adapter: live.adapter, output: snapshot }),
        usageMeter: externalAgentUsageLimitMeter({ adapter: live.adapter, output: snapshot }),
        seq: live.outputSeq,
        observedAt: new Date().toISOString()
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
    if (row.outputSnapshot) {
      const adapter = getExternalAgentProviderAdapter(row.provider);
      return {
        state: 'history',
        externalAgentSessionId: id as ExternalAgentSessionId,
        provider: row.provider,
        output: row.outputSnapshot,
        events: externalAgentStreamItems({ id, adapter, output: row.outputSnapshot, mode: 'history' }),
        usageMeter: externalAgentUsageLimitMeter({ adapter, output: row.outputSnapshot }),
        observedAt: row.updatedAt
      };
    }
    return {
      state: 'unavailable',
      externalAgentSessionId: id as ExternalAgentSessionId,
      provider: row.provider,
      reason: 'provider history unavailable'
    };
  }

  /** The neutral UI plane: the full projected event list for the session's current output, re-derived
   *  from the whole snapshot every call (never a delta), so a consumer replaces its list wholesale. */
  observeUi(id: string): ExternalAgentUiObservationFrame {
    const live = this.ctx.live.get(id);
    if (live) {
      const snapshot = live.outputBuffer.snapshot();
      return {
        state: 'live',
        externalAgentSessionId: id as ExternalAgentSessionId,
        provider: live.provider,
        observationEpoch: live.observationEpoch,
        ...(live.providerHistoryCheckpoint ? { providerHistoryCheckpoint: live.providerHistoryCheckpoint } : {}),
        events: externalAgentNeutralStreamItems({ id, adapter: live.adapter, output: snapshot }),
        seq: live.outputSeq,
        observedAt: new Date().toISOString()
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
    if (row.outputSnapshot) {
      const adapter = getExternalAgentProviderAdapter(row.provider);
      return {
        state: 'history',
        externalAgentSessionId: id as ExternalAgentSessionId,
        provider: row.provider,
        events: externalAgentNeutralStreamItems({ id, adapter, output: row.outputSnapshot, mode: 'history' }),
        observedAt: row.updatedAt
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
    if (base.state !== 'unavailable') return base;
    const row = this.ctx.store.getExternalAgentSession(id);
    if (!row || !isManagedProjectRuntime(row) || !row.providerSessionRef) return base;
    const adapter = getExternalAgentProviderAdapter(row.provider);
    const cliOutput = await providerHistoryOutputViaCli(row, adapter, {
      agents: this.ctx.agents,
      buildSpawnEnv: (env) => this.ctx.buildSpawnEnv(env),
      takeStructuredLines: (structuredId, stream, chunk) => this.ctx.takeStructuredLines(structuredId, stream, chunk),
      dropStructuredBuffer: (structuredId) => this.ctx.dropStructuredBuffer(structuredId)
    }).catch(() => null);
    if (cliOutput) {
      return {
        state: 'history',
        externalAgentSessionId: id as ExternalAgentSessionId,
        provider: row.provider,
        output: cliOutput,
        events: externalAgentStreamItems({ id, adapter, output: cliOutput, mode: 'history' }),
        usageMeter: externalAgentUsageLimitMeter({ adapter, output: cliOutput }),
        observedAt: row.updatedAt
      };
    }
    const localOutput = await providerHistoryOutputFromLocal(row, adapter);
    if (localOutput) {
      return {
        state: 'history',
        externalAgentSessionId: id as ExternalAgentSessionId,
        provider: row.provider,
        output: localOutput,
        events: externalAgentStreamItems({ id, adapter, output: localOutput, mode: 'history' }),
        usageMeter: externalAgentUsageLimitMeter({ adapter, output: localOutput }),
        observedAt: row.updatedAt
      };
    }
    return base;
  }
}
