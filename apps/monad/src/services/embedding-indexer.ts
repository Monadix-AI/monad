import type { LedgerCategory, TokenUsage } from '@monad/protocol';
import type { EmbedResult, ModelPrice } from '@/agent/index.ts';

import { computeCost } from '@/agent/index.ts';

/** What the indexer needs from the store — structural so tests can supply a fake. */
interface IndexerStore {
  messagesMissingEmbedding(sessionId?: string, limit?: number): { id: string; text: string }[];
  pendingEmbeddingCount(sessionId?: string): number;
  upsertEmbedding(messageId: string, vec: number[], model?: string): void;
  recordLedger(provider: string, model: string, category: LedgerCategory, usage: TokenUsage, costUsd?: number): void;
}

export interface EmbeddingIndexerDeps {
  store: IndexerStore;
  /** The gateway's embed (throws when no embedding model is configured — treated as "disabled"). */
  embed(texts: string[]): Promise<EmbedResult>;
  /** Current embedding-model spec ("providerId:modelId"); undefined ⇒ embedding disabled, no-op. */
  embeddingModelSpec(): string | undefined;
  /** Catalog price lookup for booking embedding cost (real cost only; absent ⇒ tokens-only). */
  price(provider: string, modelId: string): ModelPrice | undefined;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Progress callback after each batch, for surfacing an "indexing N left" hint to clients. */
  onProgress?: (status: { pending: number; embedded: number }) => void;
  /** Max texts per provider call (count cap). Default 32. */
  batchSize?: number;
  /** Max total characters per provider call (token-budget proxy). Each text is also truncated to
   *  this length so a single oversized message can't blow the request limit or wedge the queue.
   *  Default 16000. */
  maxBatchChars?: number;
  /** Pause between batches to be gentle on the provider during a large backfill. Default 0. */
  throttleMs?: number;
  /** After a batch error, suppress further work for this long (avoids a tight retry/log-spam loop
   *  against a down provider). The next kick after it elapses resumes. Default 30000. */
  errorCooldownMs?: number;
}

function splitSpec(spec: string): { provider: string; modelId: string } {
  const i = spec.indexOf(':');
  return i > 0 ? { provider: spec.slice(0, i), modelId: spec.slice(i + 1) } : { provider: '', modelId: spec };
}

/**
 * Embeds messages off the request path. The work-list is derived from the DB
 * (`messagesMissingEmbedding`), so the indexer holds no queue state: a crash/restart resumes
 * simply by re-deriving what's still missing. Single-flight — concurrent `kick()`s coalesce, and
 * a kick that arrives mid-drain schedules exactly one more pass so nothing is missed.
 */
export class EmbeddingIndexer {
  private running = false;
  private rerun = false;
  private cooldownUntilMs = 0;
  private readonly batchSize: number;
  private readonly maxBatchChars: number;
  private readonly throttleMs: number;
  private readonly errorCooldownMs: number;

  constructor(private readonly deps: EmbeddingIndexerDeps) {
    this.batchSize = deps.batchSize ?? 32;
    this.maxBatchChars = deps.maxBatchChars ?? 16_000;
    this.throttleMs = deps.throttleMs ?? 0;
    this.errorCooldownMs = deps.errorCooldownMs ?? 30_000;
  }

  private coolingDown(): boolean {
    return Date.now() < this.cooldownUntilMs;
  }

  /** Current indexer status: how many messages still need embedding + whether a drain is running. */
  status(): { pending: number; running: boolean } {
    return { pending: this.deps.store.pendingEmbeddingCount(), running: this.running };
  }

  /** Trigger a drain. Returns immediately; the drain runs in the background. */
  kick(): void {
    if (!this.deps.embeddingModelSpec() || this.coolingDown()) return; // disabled or backing off
    void this.drain();
  }

  /** Drain to idle. `kick()` calls this fire-and-forget; await it directly for deterministic flushes. */
  async drain(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.rerun = false;
        await this.pass();
      } while (this.rerun);
    } finally {
      this.running = false;
    }
  }

  private async pass(): Promise<void> {
    const spec = this.deps.embeddingModelSpec();
    if (!spec || this.coolingDown()) return;
    const fallback = splitSpec(spec);
    let embedded = 0;

    for (;;) {
      const rows = this.deps.store.messagesMissingEmbedding(undefined, this.batchSize);
      if (rows.length === 0) break;

      // Pack a sub-batch within the char budget; truncate each text so a single oversized message
      // can't exceed the provider's request limit (or wedge the queue as an un-embeddable poison row).
      const batch: { id: string; text: string }[] = [];
      let chars = 0;
      for (const r of rows) {
        const text = r.text.length > this.maxBatchChars ? r.text.slice(0, this.maxBatchChars) : r.text;
        if (batch.length > 0 && chars + text.length > this.maxBatchChars) break;
        batch.push({ id: r.id, text });
        chars += text.length;
      }

      let result: EmbedResult;
      try {
        result = await this.deps.embed(batch.map((m) => m.text));
      } catch (err) {
        // Provider down / not configured — back off so frequent kicks don't tight-loop, and stop
        // this pass; the next kick after the cooldown resumes from the DB state.
        this.cooldownUntilMs = Date.now() + this.errorCooldownMs;
        this.deps.log('warn', `embedding-indexer: batch failed, backing off: ${String(err)}`);
        return;
      }

      const usage = result.usage;
      const model = usage?.modelId ?? fallback.modelId;
      batch.forEach((m, i) => {
        const v = result.embeddings[i];
        if (v) this.deps.store.upsertEmbedding(m.id, v, model);
      });
      embedded += batch.length;

      if (usage) {
        const provider = usage.provider ?? fallback.provider;
        const modelId = usage.modelId ?? fallback.modelId;
        const cost = computeCost(usage, this.price(provider, modelId), usage.costUsd);
        this.deps.store.recordLedger(provider, modelId, 'embedding', usage, cost.usd ?? 0);
      }

      const pending = this.deps.store.messagesMissingEmbedding(undefined, 1).length;
      this.deps.onProgress?.({ pending, embedded });
      if (pending === 0) break;
      if (this.throttleMs) await Bun.sleep(this.throttleMs);
    }
  }

  private price(provider: string, modelId: string): ModelPrice | undefined {
    return provider ? this.deps.price(provider, modelId) : undefined;
  }
}
