// Schema-first at the network boundary: the response is parsed (never cast), and a malformed
// model is skipped rather than poisoning the catalog. Offline-friendly: a cached copy loads
// at startup, and a failed refresh keeps the previous data.

import type { ModelKind, ModelModalities } from '@monad/protocol';
import type { ModelPrice } from '#/agent/index.ts';

import { rename } from 'node:fs/promises';
import { z } from 'zod';

// ModelKind/ModelModalities are single-sourced in @monad/protocol (sdk-atom's ModelInfo carries
// them too); re-exported here for existing model-catalog consumers.
export type { ModelKind, ModelModalities } from '@monad/protocol';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const MODELS_DEV_MODELS_URL = 'https://models.dev/models.json';
const MODELS_DEV_PAGE_BASE = 'https://models.dev/models/';
const DEFAULT_REFRESH_MS = 24 * 60 * 60 * 1000; // daily
const FETCH_TIMEOUT_MS = 15_000;

// lenient — external data, fields may be partial/added at any time
const catalogModelSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    family: z.string().optional(),
    reasoning: z.boolean().optional(),
    tool_call: z.boolean().optional(),
    release_date: z.string().optional(),
    modalities: z
      .object({ input: z.array(z.string()).optional(), output: z.array(z.string()).optional() })
      .partial()
      .optional(),
    limit: z.object({ context: z.number().optional() }).partial().optional(),
    cost: z
      .object({
        input: z.number().optional(),
        output: z.number().optional(),
        cache_read: z.number().optional(),
        cache_write: z.number().optional()
      })
      .partial()
      .optional()
  })
  .loose();
const catalogProviderSchema = z.object({ models: z.record(z.string(), z.unknown()).default({}) }).loose();
const catalogResponseSchema = z.record(z.string(), catalogProviderSchema);
const catalogPageModelSchema = z
  .object({
    id: z.string()
  })
  .loose();
const catalogPageResponseSchema = z.record(z.string(), catalogPageModelSchema);

/** The flattened, monad-facing metadata for one model (the subset we use for tiering). */
export interface ModelCatalogEntry {
  /** Model id as models.dev reports it, e.g. "openai/gpt-5.2". */
  id: string;
  /** The provider key it was listed under. */
  provider: string;
  name?: string;
  /** USD per 1M input / output / cache-read / cache-write tokens. */
  costInput?: number;
  costOutput?: number;
  costCacheRead?: number;
  costCacheWrite?: number;
  contextLimit?: number;
  reasoning?: boolean;
  toolCall?: boolean;
  /** Supported input modalities (e.g. ["text","image"]). `image` ⇒ usable for the `vision` role. */
  modalities?: string[];
  /** Supported output modalities (e.g. ["text"] / ["image"] / ["audio"]) — drives generation roles. */
  outputModalities?: string[];
  /** Primary role this model serves, derived from output modality + id (see classifyKind). */
  kind?: ModelKind;
  releaseDate?: string;
  /** Canonical models.dev detail page id, e.g. "google/gemini-2.5-pro". */
  modelsDevPageId?: string;
}

/** models.dev doesn't flag embedding models distinctly (they report in/out: ["text"]), so embedding
 *  is detected by id; generation kinds come from the output modality; everything else is chat.
 *  (`vision` is not a kind — it's an input capability, surfaced via `modalities` containing "image".) */
export function classifyKind(id: string, output: string[] | undefined): ModelKind {
  if (/embed/i.test(id)) return 'embedding';
  if (output?.includes('embeddings') || output?.includes('embedding')) return 'embedding';
  if (output?.includes('image')) return 'image';
  if (output?.includes('video')) return 'video';
  if (output?.includes('speech')) return 'speech';
  if (output?.includes('audio')) return 'audio';
  if (output?.includes('rerank')) return 'rerank';
  if (output?.includes('transcription')) return 'transcription';
  return 'chat';
}

export type ModelTier = 'fast' | 'smart' | 'power';

export interface TierableModel {
  id: string;
  /** Blended price ($/1M in + out); undefined when unpriced (→ smart). */
  cost?: number;
}

/**
 * Bucket a set of models into fast/smart/power by **ranking blended cost within the set** —
 * self-calibrating, so it stays vendor- and time-neutral (no absolute price thresholds that
 * rot as the market moves). Models with no pricing land in `smart` (unknown). `overrides`
 * (a modelId→tier map the operator sets) always win. Guarantees the cheapest/priciest land in
 * fast/power when there are ≥3 priced models, so a `tier` request can always resolve.
 */
export function assignTiers(
  models: TierableModel[],
  overrides: Record<string, ModelTier> = {}
): Map<string, ModelTier> {
  const tiers = new Map<string, ModelTier>();
  const ranked = models.filter((m) => m.cost !== undefined).sort((a, b) => (a.cost as number) - (b.cost as number));
  const n = ranked.length;
  const autoTier = (i: number): ModelTier => {
    if (n <= 1) return 'smart';
    if (n === 2) return i === 0 ? 'fast' : 'power';
    const low = Math.floor(n / 3);
    const high = n - low;
    return i < low ? 'fast' : i >= high ? 'power' : 'smart';
  };
  for (const [i, m] of ranked.entries()) tiers.set(m.id, autoTier(i));
  for (const m of models) if (!tiers.has(m.id)) tiers.set(m.id, 'smart');
  for (const [id, t] of Object.entries(overrides)) tiers.set(id, t);
  return tiers;
}

const entrySchema: z.ZodType<ModelCatalogEntry> = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string().optional(),
  costInput: z.number().optional(),
  costOutput: z.number().optional(),
  costCacheRead: z.number().optional(),
  costCacheWrite: z.number().optional(),
  contextLimit: z.number().optional(),
  reasoning: z.boolean().optional(),
  toolCall: z.boolean().optional(),
  modalities: z.array(z.string()).optional(),
  outputModalities: z.array(z.string()).optional(),
  kind: z.enum(['chat', 'image', 'speech', 'embedding']).optional(),
  releaseDate: z.string().optional(),
  modelsDevPageId: z.string().optional()
});

function dotNormalizedModelId(modelId: string): string {
  const [lab, ...rest] = modelId.split('/');
  if (rest.length === 0) return modelId.replaceAll('.', '-');
  return `${lab}/${rest.join('/').replaceAll('.', '-')}`;
}

function createPageResolver(pages: z.infer<typeof catalogPageResponseSchema>) {
  const byId = new Set(Object.keys(pages));
  return (provider: string, model: { id: string }) => {
    if (byId.has(model.id)) return model.id;
    const providerScoped = `${provider}/${model.id}`;
    if (byId.has(providerScoped)) return providerScoped;
    const normalized = dotNormalizedModelId(model.id);
    if (byId.has(normalized)) return normalized;
    const normalizedProviderScoped = dotNormalizedModelId(providerScoped);
    return byId.has(normalizedProviderScoped) ? normalizedProviderScoped : undefined;
  };
}

function flatten(
  catalog: z.infer<typeof catalogResponseSchema>,
  pages: z.infer<typeof catalogPageResponseSchema> = {}
): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = [];
  const resolvePage = createPageResolver(pages);
  for (const [provider, p] of Object.entries(catalog)) {
    for (const raw of Object.values(p.models)) {
      const parsed = catalogModelSchema.safeParse(raw);
      if (!parsed.success) continue;
      const m = parsed.data;
      const pageId = resolvePage(provider, m);
      entries.push({
        id: m.id,
        provider,
        name: m.name,
        costInput: m.cost?.input,
        costOutput: m.cost?.output,
        costCacheRead: m.cost?.cache_read,
        costCacheWrite: m.cost?.cache_write,
        contextLimit: m.limit?.context,
        reasoning: m.reasoning,
        toolCall: m.tool_call,
        modalities: m.modalities?.input,
        outputModalities: m.modalities?.output,
        kind: classifyKind(m.id, m.modalities?.output),
        releaseDate: m.release_date,
        modelsDevPageId: pageId
      });
    }
  }
  return entries;
}

async function fetchCatalogPages(
  fetchImpl: typeof fetch,
  modelsUrl: string
): Promise<z.infer<typeof catalogPageResponseSchema>> {
  try {
    const res = await fetchImpl(modelsUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return {};
    const parsed = catalogPageResponseSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export interface ModelCatalogDeps {
  /** Path to the on-disk cache (e.g. ~/.monad/cache/model-catalog.json). */
  cachePath: string;
  log: (level: 'debug' | 'info' | 'warn', message: string) => void;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
  url?: string;
  modelsUrl?: string;
}

/** A configured routing profile the daemon can run. */
export interface TierableProfile {
  alias: string;
  routes: {
    chat: { provider: string; modelId: string };
    fast?: { provider: string; modelId: string };
  };
}

export class ModelCatalogService {
  // Lean in-memory index: only the blended cost we actually use for tiering, keyed by full id
  // and (fallback) by bare model name. The full catalog stays on disk — holding 5k+ rich model
  // objects in RAM is wasteful when tiering needs nothing but a price.
  private costById = new Map<string, number>();
  private costBySuffix = new Map<string, number>();
  // Full per-class price ($/1M) for cost computation (distinct from the blended `cost` used only
  // for tiering). Same id + bare-suffix keying as the blended index.
  private priceById = new Map<string, ModelPrice>();
  private priceBySuffix = new Map<string, ModelPrice>();
  private contextById = new Map<string, number>();
  private contextBySuffix = new Map<string, number>();
  private releaseDateById = new Map<string, string>();
  private releaseDateBySuffix = new Map<string, string>();
  private modalitiesById = new Map<string, ModelModalities>();
  private modalitiesBySuffix = new Map<string, ModelModalities>();
  private modelsDevPageById = new Map<string, string>();
  private nameById = new Map<string, string>();
  private count = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly url: string;
  private readonly modelsUrl: string;

  constructor(private readonly deps: ModelCatalogDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.url = deps.url ?? MODELS_DEV_URL;
    this.modelsUrl = deps.modelsUrl ?? MODELS_DEV_MODELS_URL;
  }

  /** Number of priced models indexed in memory. */
  get size(): number {
    return this.count;
  }

  /** Blended cost ($/1M) for a catalog model id, or undefined. */
  cost(id: string): number | undefined {
    return this.costById.get(id);
  }

  /**
   * Best-effort join from a configured (provider, modelId) to the model's blended cost. Profiles
   * store a native id ("claude-sonnet-4-5") or a gateway-prefixed one ("anthropic/claude-...");
   * the catalog keys are "provider/model" — try the id as-is, then "provider/id", then the
   * bare-name fallback. Misses are fine: an un-joined model just tiers as `smart` (overridable).
   */
  lookupCost(provider: string, modelId: string): number | undefined {
    return (
      this.costById.get(modelId) ??
      this.costById.get(`${provider}/${modelId}`) ??
      this.costBySuffix.get(modelId.split('/').pop() ?? modelId)
    );
  }

  /** Full per-class price ($/1M) for a configured (provider, modelId) — for real cost computation.
   *  Same 3-key fallback as {@link lookupCost}. Undefined ⇒ cost is `unknown` (never estimated). */
  lookupPrice(provider: string, modelId: string): ModelPrice | undefined {
    return (
      this.priceById.get(modelId) ??
      this.priceById.get(`${provider}/${modelId}`) ??
      this.priceBySuffix.get(modelId.split('/').pop() ?? modelId)
    );
  }

  /** Strict price join for *display* — only an exact id / `provider/id` match, no bare-name suffix
   *  fallback. The suffix fallback is fine for tiering (a near-miss still tiers sanely) but unsafe
   *  for showing a number: it would map e.g. `claude-opus-4.8` onto a different version's price. */
  lookupPriceExact(provider: string, modelId: string): ModelPrice | undefined {
    return this.priceById.get(modelId) ?? this.priceById.get(`${provider}/${modelId}`);
  }

  /**
   * Tier a set of model ids using the cached pricing. Ids absent from the catalog fall into
   * `smart`. `overrides` (operator-set modelId→tier) win. The set is what makes ranking
   * self-calibrating — pass the user's *configured* models.
   */
  tiers(modelIds: string[], overrides?: Record<string, ModelTier>): Map<string, ModelTier> {
    return assignTiers(
      modelIds.map((id) => ({ id, cost: this.costById.get(id) })),
      overrides
    );
  }

  /** Tier the configured profiles by their model's cost (keyed by alias). Overrides keyed by alias. */
  tierProfiles(profiles: TierableProfile[], overrides?: Record<string, ModelTier>): Map<string, ModelTier> {
    return assignTiers(
      profiles.map((p) => ({ id: p.alias, cost: this.lookupCost(p.routes.chat.provider, p.routes.chat.modelId) })),
      overrides
    );
  }

  /**
   * Resolve the 'fast' tier to a concrete model spec ("providerId:modelId"). Prefers the
   * profile's explicitly designated fast model; falls back to the cheapest priced profile's
   * default model. Returns undefined when no profile has a fast model set and no priced
   * profile exists (caller falls back to the session's default model).
   */
  pickProfileForTier(
    _tier: ModelTier,
    profiles: TierableProfile[],
    _overrides?: Record<string, ModelTier>
  ): string | undefined {
    // Explicit fast-model designation takes priority.
    const withFast = profiles.find((p) => p.routes.fast);
    if (withFast?.routes.fast) return `${withFast.routes.fast.provider}:${withFast.routes.fast.modelId}`;
    // Fall back to the cheapest priced profile's model.
    const cost = (p: TierableProfile) => this.lookupCost(p.routes.chat.provider, p.routes.chat.modelId);
    const priced = profiles
      .flatMap((profile) => {
        const modelCost = cost(profile);
        return modelCost === undefined ? [] : [{ profile, cost: modelCost }];
      })
      .sort((a, b) => a.cost - b.cost);
    return priced[0] ? `${priced[0].profile.routes.chat.provider}:${priced[0].profile.routes.chat.modelId}` : undefined;
  }

  /** Best-effort join from a configured (provider, modelId) to the model's context-window size. */
  lookupContextLimit(provider: string, modelId: string): number | undefined {
    return (
      this.contextById.get(modelId) ??
      this.contextById.get(`${provider}/${modelId}`) ??
      this.contextBySuffix.get(modelId.split('/').pop() ?? modelId)
    );
  }

  /** Best-effort join from a configured (provider, modelId) to the model release date. */
  lookupReleaseDate(provider: string, modelId: string): string | undefined {
    return (
      this.releaseDateById.get(modelId) ??
      this.releaseDateById.get(`${provider}/${modelId}`) ??
      this.releaseDateBySuffix.get(modelId.split('/').pop() ?? modelId)
    );
  }

  /** Link to the exact models.dev model page when the catalog has an exact id match. */
  lookupModelsDevUrl(provider: string, modelId: string): string | undefined {
    const id = this.modelsDevPageById.get(modelId) ?? this.modelsDevPageById.get(`${provider}/${modelId}`);
    return id ? `${MODELS_DEV_PAGE_BASE}${id.split('/').map(encodeURIComponent).join('/')}` : undefined;
  }

  /** Display name from an exact models.dev id match. */
  lookupLabel(provider: string, modelId: string): string | undefined {
    return this.nameById.get(modelId) ?? this.nameById.get(`${provider}/${modelId}`);
  }

  /** Best-effort join from a configured (provider, modelId) to the model's modalities — used to
   *  filter role candidates. Same 3-key fallback as {@link lookupCost}; modalities are stable
   *  across point versions so the bare-suffix fallback is safe. */
  lookupCapabilities(provider: string, modelId: string): ModelModalities | undefined {
    return (
      this.modalitiesById.get(modelId) ??
      this.modalitiesById.get(`${provider}/${modelId}`) ??
      this.modalitiesBySuffix.get(modelId.split('/').pop() ?? modelId)
    );
  }

  private indexCosts(entries: ModelCatalogEntry[]): void {
    this.costById = new Map();
    this.costBySuffix = new Map();
    this.priceById = new Map();
    this.priceBySuffix = new Map();
    this.contextById = new Map();
    this.contextBySuffix = new Map();
    this.releaseDateById = new Map();
    this.releaseDateBySuffix = new Map();
    this.modalitiesById = new Map();
    this.modalitiesBySuffix = new Map();
    this.modelsDevPageById = new Map();
    this.nameById = new Map();
    for (const e of entries) {
      const suffix = e.id.split('/').pop();
      if (e.name) {
        this.nameById.set(e.id, e.name);
        this.nameById.set(`${e.provider}/${e.id}`, e.name);
      }
      if (e.modelsDevPageId) {
        this.modelsDevPageById.set(e.id, e.modelsDevPageId);
        this.modelsDevPageById.set(`${e.provider}/${e.id}`, e.modelsDevPageId);
      }
      if (e.contextLimit !== undefined) {
        this.contextById.set(e.id, e.contextLimit);
        if (suffix && !this.contextBySuffix.has(suffix)) this.contextBySuffix.set(suffix, e.contextLimit);
      }
      if (e.releaseDate) {
        this.releaseDateById.set(e.id, e.releaseDate);
        this.releaseDateById.set(`${e.provider}/${e.id}`, e.releaseDate);
        if (suffix && !this.releaseDateBySuffix.has(suffix)) this.releaseDateBySuffix.set(suffix, e.releaseDate);
      }
      // Modalities are indexed for EVERY model (even unpriced ones, e.g. free embedding models) —
      // so it must come before the cost-gated `continue` below.
      const modalities: ModelModalities = {
        input: e.modalities,
        output: e.outputModalities,
        reasoning: e.reasoning,
        toolCall: e.toolCall,
        kind: e.kind
      };
      this.modalitiesById.set(e.id, modalities);
      if (suffix && !this.modalitiesBySuffix.has(suffix)) this.modalitiesBySuffix.set(suffix, modalities);
      if (e.costInput === undefined && e.costOutput === undefined) continue;
      const blended = (e.costInput ?? 0) + (e.costOutput ?? 0);
      this.costById.set(e.id, blended);
      if (suffix && !this.costBySuffix.has(suffix)) this.costBySuffix.set(suffix, blended);
      const price: ModelPrice = {
        input: e.costInput,
        output: e.costOutput,
        cacheRead: e.costCacheRead,
        cacheWrite: e.costCacheWrite
      };
      this.priceById.set(e.id, price);
      if (suffix && !this.priceBySuffix.has(suffix)) this.priceBySuffix.set(suffix, price);
    }
    this.count = this.costById.size;
  }

  async loadCache(): Promise<void> {
    try {
      const file = Bun.file(this.deps.cachePath);
      if (!(await file.exists())) return;
      const parsed = z.array(entrySchema).safeParse(JSON.parse(await file.text()));
      if (parsed.success) this.indexCosts(parsed.data);
    } catch (err) {
      this.deps.log('warn', `model catalog cache unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Fetch models.dev, parse, flatten, index cost in memory, and write the full catalog to disk
   * (atomically — kept on disk for future richer use). Non-fatal: on any failure the previous
   * index is kept. Returns whether it refreshed.
   */
  async refresh(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(this.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const pages = await fetchCatalogPages(this.fetchImpl, this.modelsUrl);
      const entries = flatten(catalogResponseSchema.parse(await res.json()), pages);
      this.indexCosts(entries);
      await this.writeCache(entries);
      this.deps.log('debug', `model catalog: ${this.count} priced models indexed from models.dev`);
      return true;
    } catch (err) {
      this.deps.log('warn', `model catalog refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private async writeCache(entries: ModelCatalogEntry[]): Promise<void> {
    const tmp = `${this.deps.cachePath}.tmp`;
    await Bun.write(tmp, JSON.stringify(entries));
    await rename(tmp, this.deps.cachePath);
  }

  /** Refresh now (cached → immediate), then on an interval. The first refresh runs detached. */
  startAutoRefresh(intervalMs: number = DEFAULT_REFRESH_MS): void {
    this.timer = setInterval(() => void this.refresh(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
