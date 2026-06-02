// mem0 L1 backend — wraps the mem0 OSS in-process Memory (local vector store + SQLite history;
// cloud OpenAI for extraction/embeddings). A swappable replacement for the built-in MD backend
// (P5). The adapter talks to an injected Mem0Client so it is testable without the real SDK; the
// daemon lazily imports `mem0ai/oss` to build the real one.

import type { Logger } from '@monad/logger';
import type { Fact, L1Capabilities, MemoryBlock, MemoryScope, RecallCtx, WriteCtx } from '@monad/protocol';
import type { L1Adapter, MemoryToolSchema, MemoryTurn } from '@/agent/index.ts';
import type { Mem0ModelSpec, Mem0Models } from '@/services/memory/resolve-mem0.ts';

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface Mem0Memory {
  id: string;
  memory: string;
  score?: number;
}

/** The slice of the mem0 OSS Memory API the adapter uses (a fake stands in for tests). */
export interface Mem0Client {
  add(
    messages: { role: string; content: string }[],
    opts: { userId?: string; metadata?: Record<string, unknown>; infer?: boolean }
  ): Promise<{ results: Mem0Memory[] }>;
  search(query: string, opts: { topK?: number; filters?: { user_id?: string } }): Promise<{ results: Mem0Memory[] }>;
  getAll(opts: { filters?: { user_id?: string } }): Promise<{ results: Mem0Memory[] }>;
  delete(id: string): Promise<{ message: string }>;
}

const MEM0_CAPS: L1Capabilities = {
  provenance: false, // mem0 hides provenance server-side
  vectorSearch: true,
  inferredWrite: true,
  history: true,
  prefetch: false
};

const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

// mem0's scope key. We map each agent to a mem0 `userId` (per-agent isolation). mem0 is a wholesale
// black box, so our finer global/session granularity is not represented.
function userIdFor(scope: MemoryScope): string {
  return scope.kind === 'global' ? 'global' : scope.id;
}

export class Mem0Adapter implements L1Adapter {
  readonly name = 'mem0';
  constructor(
    private readonly client: Mem0Client,
    private readonly log: Logger
  ) {}

  isAvailable(): boolean {
    return true;
  }
  capabilities(): L1Capabilities {
    return MEM0_CAPS;
  }

  async recall(ctx: RecallCtx): Promise<MemoryBlock> {
    try {
      const res = await this.client.search(ctx.query, { topK: 20, filters: { user_id: ctx.agentId } });
      const facts: Fact[] = [];
      let used = 0;
      for (const m of res.results) {
        const cost = m.memory.length + 3;
        if (used + cost > ctx.budget.facts) break;
        facts.push({ id: m.id, content: m.memory, scope: { kind: 'agent', id: ctx.agentId }, provClass: 'machine' });
        used += cost;
      }
      return { facts, tokens: estimateTokens(facts.map((f) => f.content).join('\n')) };
    } catch (err) {
      this.log.warn(`mem0: recall failed: ${String(err)}`);
      return { facts: [], tokens: 0 };
    }
  }

  async observe(turn: MemoryTurn, ctx: WriteCtx): Promise<void> {
    // mem0 runs its own cloud extraction over the exchange (infer=true, the default).
    try {
      await this.client.add(
        [
          { role: 'user', content: turn.user },
          { role: 'assistant', content: turn.assistant }
        ],
        { userId: userIdFor(ctx.scope) }
      );
    } catch (err) {
      this.log.warn(`mem0: observe failed: ${String(err)}`);
    }
  }

  toolSchemas(): MemoryToolSchema[] {
    return [];
  }
  async handleToolCall(name: string): Promise<string> {
    throw new Error(`mem0 adapter has no tool '${name}'`);
  }

  // mem0 has no session scope to drop (cloud-managed); session end is a no-op.
  async onSessionEnd(): Promise<void> {}

  // ── control-API facade (browse/edit mem0 memories from the UI) ──
  async listFacts(scope: MemoryScope): Promise<Fact[]> {
    const res = await this.client.getAll({ filters: { user_id: userIdFor(scope) } });
    return res.results.map((m) => ({ id: m.id, content: m.memory, scope, provClass: 'machine' as const }));
  }
  async addFact(scope: MemoryScope, content: string): Promise<Fact | null> {
    // infer:false stores the user's exact text rather than re-extracting it.
    const res = await this.client.add([{ role: 'user', content }], { userId: userIdFor(scope), infer: false });
    const m = res.results[0];
    return m ? { id: m.id, content: m.memory, scope, provClass: 'user' } : null;
  }
  async forgetFact(id: string): Promise<boolean> {
    await this.client.delete(id);
    return true;
  }
}

export interface BuildMem0Options {
  /** Resolved LLM + embedder (chosen from Monad's model registry) + the embedder's dimension. */
  models: Mem0Models | undefined;
  historyDbPath: string;
  /** Vector store override. mem0-JS has NO embedded on-disk store — its qdrant/chroma/pgvector clients
   *  are server-only (unlike Python's local mode), and the default 'memory' provider is IN-RAM (lost on
   *  restart). To persist, point this at a running server, e.g.
   *  `{ provider: 'qdrant', config: { url: 'http://127.0.0.1:6333', collectionName, dimension } }`. */
  vectorStore?: { provider: string; config?: Record<string, unknown> };
}

// mem0's per-provider config keys vary; we pass apiKey + model + (baseURL under several common
// aliases) so the same shape works for OpenAI, OpenAI-compatible, Ollama, etc. Unused keys are ignored.
function providerConfig(spec: Mem0ModelSpec): Record<string, unknown> {
  const cfg: Record<string, unknown> = { model: spec.model };
  if (spec.apiKey) cfg.apiKey = spec.apiKey;
  if (spec.baseUrl) {
    cfg.baseURL = spec.baseUrl;
    cfg.openai_base_url = spec.baseUrl;
    cfg.ollamaBaseURL = spec.baseUrl;
  }
  return cfg;
}

/**
 * Construct the mem0 OSS client from a resolved model selection. Returns null when the models
 * couldn't be resolved from Monad's config — the caller then falls back to the built-in backend.
 * mem0ai is a bundled dependency (always available in both dev and release binary).
 */
export async function buildMem0Client(opts: BuildMem0Options, log: Logger): Promise<Mem0Client | null> {
  if (!opts.models) {
    log.warn('mem0: model selection unresolved (configure memory.mem0 llm/embedder) — staying on builtin');
    return null;
  }
  const { llm, embedder, dim } = opts.models;
  try {
    const mod = (await import('mem0ai/oss')) as unknown as { Memory: new (cfg: unknown) => Mem0Client };
    // Default to mem0's in-RAM store (non-persistent across restart — mem0-JS has no embedded on-disk
    // store; configure memory.mem0.vectorStore with a server to persist). History (the dedup/audit log)
    // IS persisted to historyDbPath regardless. A configured store inherits collectionName + dimension
    // (the embedder's) unless its own config overrides them.
    const provider = opts.vectorStore?.provider ?? 'memory';
    const vectorStore = {
      provider,
      config: { collectionName: 'monad_memories', dimension: dim, ...opts.vectorStore?.config }
    };
    if (provider === 'memory')
      log.info('mem0: using the in-RAM vector store (memories reset on restart; set a server to persist)');
    else log.info(`mem0: vector store = ${provider} (persistent)`);
    // mem0's Memory opens historyDbPath via SQLite, which does NOT create parent dirs — ensure it exists.
    await mkdir(dirname(opts.historyDbPath), { recursive: true });
    return new mod.Memory({
      embedder: { provider: embedder.provider, config: providerConfig(embedder) },
      vectorStore,
      llm: { provider: llm.provider, config: providerConfig(llm) },
      historyDbPath: opts.historyDbPath
    });
  } catch (err) {
    log.warn(`mem0: failed to initialise (${String(err)})`);
    return null;
  }
}
