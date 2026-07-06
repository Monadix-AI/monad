import type { NativeCliObservationAccessResponse } from '@monad/protocol';
import type { LiveNativeCliSession, NativeCliHostDeps } from '@/services/native-cli/host/host-types.ts';

import { nativeCliStreamItems, nativeCliUsageLimitMeter } from '@monad/atoms/native-cli-observation';

import {
  providerHistoryOutputFromLocal,
  providerHistoryOutputViaCli
} from '@/services/native-cli/host/history-backfill.ts';
import { isManagedProjectRuntime } from '@/services/native-cli/host/host-helpers.ts';
import { getNativeCliProviderAdapter } from '@/services/native-cli/index.ts';

export interface NativeCliObservationResolveContext {
  live: Map<string, LiveNativeCliSession>;
  store: NativeCliHostDeps['store'];
  agents: NativeCliHostDeps['agents'];
  buildSpawnEnv(env?: Record<string, string>): Promise<Record<string, string>>;
  takeStructuredLines(id: string, stream: 'stdout' | 'stderr', chunk: string): string;
  dropStructuredBuffer(id: string): void;
}

/** Resolves a session's current observable state — from the live output buffer, the durable
 *  snapshot column, or (for managed-project runtimes) the provider's own history — independent of
 *  the subscription/publish side owned by `NativeCliObservationHub`. */
export class NativeCliObservationResolver {
  constructor(private readonly ctx: NativeCliObservationResolveContext) {}

  observe(id: string, afterSeq?: number): NativeCliObservationAccessResponse {
    const live = this.ctx.live.get(id);
    if (live) {
      const snapshot = live.outputBuffer.snapshot();
      // Resume: if the caller's cursor is still within the bounded tail, hand back only the delta
      // beyond it instead of the whole snapshot (a reconnecting client backfills from last-event-id).
      if (afterSeq !== undefined && live.outputSeq > afterSeq && live.outputSeq - afterSeq <= snapshot.length) {
        return {
          state: 'live',
          nativeCliSessionId: id,
          provider: live.provider,
          append: snapshot.slice(snapshot.length - (live.outputSeq - afterSeq)),
          seq: live.outputSeq,
          observedAt: new Date().toISOString()
        };
      }
      return {
        state: 'live',
        nativeCliSessionId: id,
        provider: live.provider,
        output: snapshot,
        events: nativeCliStreamItems({ id, adapter: live.adapter, output: snapshot }),
        usageMeter: nativeCliUsageLimitMeter({ adapter: live.adapter, output: snapshot }),
        seq: live.outputSeq,
        observedAt: new Date().toISOString()
      };
    }
    const row = this.ctx.store.getNativeCliSession(id);
    if (!row) {
      return {
        state: 'unavailable',
        nativeCliSessionId: id,
        reason: 'native CLI session not found'
      };
    }
    if (!isManagedProjectRuntime(row) && row.outputSnapshot) {
      const adapter = getNativeCliProviderAdapter(row.provider);
      return {
        state: 'history',
        nativeCliSessionId: id,
        provider: row.provider,
        output: row.outputSnapshot,
        events: nativeCliStreamItems({ id, adapter, output: row.outputSnapshot }),
        usageMeter: nativeCliUsageLimitMeter({ adapter, output: row.outputSnapshot }),
        observedAt: row.updatedAt
      };
    }
    return {
      state: 'unavailable',
      nativeCliSessionId: id,
      provider: row.provider,
      reason: 'provider history unavailable'
    };
  }

  async observeWithProviderHistory(id: string): Promise<NativeCliObservationAccessResponse> {
    const base = this.observe(id);
    if (base.state !== 'unavailable') return base;
    const row = this.ctx.store.getNativeCliSession(id);
    if (!row || !isManagedProjectRuntime(row) || !row.providerSessionRef) return base;
    const adapter = getNativeCliProviderAdapter(row.provider);
    const cliOutput = await providerHistoryOutputViaCli(row, adapter, {
      agents: this.ctx.agents,
      buildSpawnEnv: (env) => this.ctx.buildSpawnEnv(env),
      takeStructuredLines: (structuredId, stream, chunk) => this.ctx.takeStructuredLines(structuredId, stream, chunk),
      dropStructuredBuffer: (structuredId) => this.ctx.dropStructuredBuffer(structuredId)
    }).catch(() => null);
    if (cliOutput) {
      return {
        state: 'history',
        nativeCliSessionId: id,
        provider: row.provider,
        output: cliOutput,
        events: nativeCliStreamItems({ id, adapter, output: cliOutput }),
        usageMeter: nativeCliUsageLimitMeter({ adapter, output: cliOutput }),
        observedAt: row.updatedAt
      };
    }
    const localOutput = await providerHistoryOutputFromLocal(row, adapter);
    if (localOutput) {
      return {
        state: 'history',
        nativeCliSessionId: id,
        provider: row.provider,
        output: localOutput,
        events: nativeCliStreamItems({ id, adapter, output: localOutput }),
        usageMeter: nativeCliUsageLimitMeter({ adapter, output: localOutput }),
        observedAt: row.updatedAt
      };
    }
    return base;
  }
}
