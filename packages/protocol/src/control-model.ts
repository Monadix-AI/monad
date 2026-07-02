import { z } from 'zod';

import { modelProfileRoutesSchema, modelRoleSchema, modelRolesSchema } from './domain.ts';
import { httpsUrlSchema, httpUrlSchema } from './url.ts';

// Self-contained view shapes for model settings (gateway), no dependency on @monad/home. Secrets
// never cross this boundary: a CredentialView carries only a short `accessTokenPreview`.

export enum ModelProviderType {
  // Native: a dedicated AI SDK package backs buildModel()
  Anthropic = 'anthropic',
  OpenAI = 'openai',
  VercelGateway = 'vercel-gateway',
  OpenRouter = 'openrouter',
  Google = 'google',
  Mistral = 'mistral',
  AmazonBedrock = 'amazon-bedrock',
  Azure = 'azure',
  // OpenAI-compatible: bundled adapter + a preset base URL
  OpenAICompatible = 'openai-compatible',
  CloudflareGateway = 'cloudflare-gateway',
  Groq = 'groq',
  XAI = 'xai',
  DeepSeek = 'deepseek',
  Together = 'together',
  Fireworks = 'fireworks',
  Cerebras = 'cerebras',
  Perplexity = 'perplexity',
  Moonshot = 'moonshot',
  ZAI = 'zai',
  MiniMax = 'minimax',
  Nvidia = 'nvidia',
  Novita = 'novita',
  Ollama = 'ollama',
  HuggingFace = 'huggingface'
}

export const KNOWN_PROVIDER_TYPES = [
  ModelProviderType.Anthropic,
  ModelProviderType.OpenAI,
  ModelProviderType.VercelGateway,
  ModelProviderType.OpenRouter,
  ModelProviderType.Google,
  ModelProviderType.Mistral,
  ModelProviderType.AmazonBedrock,
  ModelProviderType.Azure,
  ModelProviderType.OpenAICompatible,
  ModelProviderType.CloudflareGateway,
  ModelProviderType.Groq,
  ModelProviderType.XAI,
  ModelProviderType.DeepSeek,
  ModelProviderType.Together,
  ModelProviderType.Fireworks,
  ModelProviderType.Cerebras,
  ModelProviderType.Perplexity,
  ModelProviderType.Moonshot,
  ModelProviderType.ZAI,
  ModelProviderType.MiniMax,
  ModelProviderType.Nvidia,
  ModelProviderType.Novita,
  ModelProviderType.Ollama,
  ModelProviderType.HuggingFace
] as const;

export type ProviderType = `${ModelProviderType}`;

// Single source of truth for the providers monad offers. The web wizard, CLI, and
// agent-core registry all derive from this. `strategy`:
//   'native'            → a dedicated AI SDK package (agent-core bundles it)
//   'openai-compatible' → bundled @ai-sdk/openai-compatible adapter at `defaultBaseUrl`

export type ProviderStrategy = 'native' | 'openai-compatible';

/** An extra config field a provider needs beyond key + base URL (e.g. AWS region).
 *  Persisted into `Provider.extra` and read back in the atom's buildModel(). */
export const providerExtraFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  placeholder: z.string().optional(),
  required: z.boolean().optional()
});
export type ProviderExtraField = z.infer<typeof providerExtraFieldSchema>;

/** Self-describing metadata a `ModelProvider` atom carries. The daemon assembles the provider
 *  catalog (consumed by the UI/CLI) from registered providers' descriptors — the built-in catalog
 *  DATA lives in @monad/atoms, not here; protocol holds only the shape + the known-type enum.
 *  `type` is an open string: a third-party provider atom may introduce a brand-new type. */
export const modelProviderDescriptorSchema = z.object({
  type: z.string(),
  label: z.string(),
  strategy: z.enum(['native', 'openai-compatible']),
  defaultBaseUrl: httpUrlSchema.optional(),
  needsUrl: z.boolean().optional(),
  keyPlaceholder: z.string().optional(),
  npmPackage: z.string().optional(),
  extraFields: z.array(providerExtraFieldSchema).optional(),
  keyOptional: z.boolean().optional()
});
export type ModelProviderDescriptor = z.infer<typeof modelProviderDescriptorSchema>;

export const getProviderCatalogResponseSchema = z.object({ providers: z.array(modelProviderDescriptorSchema) });
export type GetProviderCatalogResponse = z.infer<typeof getProviderCatalogResponseSchema>;

// Parse a provider catalogue's native pricing block ($/token) into the canonical ModelPrice
// (defined below, $/1M). Live here (not agent-core) so both the gateway and the ai-sdk-free
// provider atoms can attach price to a model listing. ModelPrice itself is single-sourced as
// `modelPriceSchema`/`ModelPrice` further down this file.

const PRICE_PER_MILLION = 1_000_000;

function perMillion(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number.parseFloat(v) : typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n * PRICE_PER_MILLION : undefined;
}

function unitPrice(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number.parseFloat(v) : typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function buildPrice(fields: {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  videoSecond?: unknown;
}): ModelPrice | undefined {
  const price: ModelPrice = {};
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
    const v = perMillion(fields[k]);
    if (v !== undefined) price[k] = v;
  }
  const videoSecond = unitPrice(fields.videoSecond);
  if (videoSecond !== undefined) price.videoSecond = videoSecond;
  return Object.keys(price).length > 0 ? price : undefined;
}

function priceUnitMeta(key: string): { label: string; unit: string; multiplier: number } {
  switch (key) {
    case 'prompt':
      return { label: 'Input', unit: 'M', multiplier: PRICE_PER_MILLION };
    case 'completion':
      return { label: 'Output', unit: 'M', multiplier: PRICE_PER_MILLION };
    case 'input_cache_read':
      return { label: 'Cache read', unit: 'M', multiplier: PRICE_PER_MILLION };
    case 'input_cache_write':
      return { label: 'Cache write', unit: 'M', multiplier: PRICE_PER_MILLION };
    case 'video':
    case 'video_second':
    case 'video_per_second':
    case 'per_second':
      return { label: 'Video', unit: 'second', multiplier: 1 };
    case 'per_minute':
      return { label: 'Audio', unit: 'minute', multiplier: 1 };
    case 'per_hour':
      return { label: 'Audio', unit: 'hour', multiplier: 1 };
    case 'image_output':
      // OpenRouter reports image_output per 64x64 tile; normalize to the public $/megapixel unit.
      return { label: 'Image output', unit: 'megapixel', multiplier: 4096 };
    case 'search':
    case 'web_search':
      return { label: 'Search', unit: 'search', multiplier: 1 };
  }
  const normalized = key.replace(/^per_/, '').replace(/_/g, ' ');
  const label = normalized.replace(/\b\w/g, (char) => char.toUpperCase());
  if (key.includes('token')) return { label, unit: 'M', multiplier: PRICE_PER_MILLION };
  if (key.includes('song')) return { label, unit: 'song', multiplier: 1 };
  if (key.includes('second')) return { label, unit: 'second', multiplier: 1 };
  if (key.includes('minute')) return { label, unit: 'minute', multiplier: 1 };
  if (key.includes('image')) return { label, unit: 'image', multiplier: 1 };
  if (key.includes('request')) return { label, unit: 'request', multiplier: 1 };
  if (key.includes('search')) return { label, unit: 'search', multiplier: 1 };
  return { label, unit: 'unit', multiplier: 1 };
}

type ModelPriceUnit = { label: string; price: number; unit: string };

function titleCaseKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function openAiPriceUnits(p: Record<string, unknown>): ModelPriceUnit[] {
  return Object.entries(p)
    .flatMap(([key, value]) => {
      const n = typeof value === 'string' ? Number.parseFloat(value) : typeof value === 'number' ? value : Number.NaN;
      if (!Number.isFinite(n) || n <= 0) return [];
      const meta = priceUnitMeta(key);
      return [{ label: meta.label, price: n * meta.multiplier, unit: meta.unit }];
    })
    .filter(
      (item, index, items) =>
        items.findIndex((other) => other.label === item.label && other.unit === item.unit) === index
    );
}

function fieldString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function vercelVideoDurationPriceUnits(value: unknown): ModelPriceUnit[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      const price = unitPrice(record.cost_per_second);
      if (price === undefined) return [];
      const parts = [
        fieldString(record, 'resolution'),
        fieldString(record, 'mode'),
        typeof record.audio === 'boolean' ? (record.audio ? 'Audio' : 'No audio') : undefined
      ].filter((part): part is string => !!part);
      return [{ label: parts.length > 0 ? parts.join(' ') : 'Video', price, unit: 'second' }];
    })
    .sort((a, b) => a.price - b.price || a.label.localeCompare(b.label))
    .filter(
      (item, index, items) =>
        items.findIndex(
          (other) => other.label === item.label && other.price === item.price && other.unit === item.unit
        ) === index
    );
}

function vercelVideoTokenPriceUnits(value: unknown): ModelPriceUnit[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, item]) => {
      if (!item || typeof item !== 'object') return [];
      const price = unitPrice((item as Record<string, unknown>).cost_per_million_tokens);
      if (price === undefined) return [];
      return [{ label: titleCaseKey(key), price, unit: 'M' }];
    })
    .sort((a, b) => a.price - b.price || a.label.localeCompare(b.label));
}

/** OpenAI/OpenRouter-style `/models` pricing block ($/token). */
export function openAiPrice(
  p:
    | {
        [key: string]: unknown;
        prompt?: unknown;
        completion?: unknown;
        input_cache_read?: unknown;
        input_cache_write?: unknown;
        video?: unknown;
        video_second?: unknown;
        video_per_second?: unknown;
        per_second?: unknown;
        per_minute?: unknown;
        per_hour?: unknown;
      }
    | null
    | undefined
): ModelPrice | undefined {
  if (!p) return undefined;
  const price = buildPrice({
    input: p.prompt,
    output: p.completion,
    cacheRead: p.input_cache_read,
    cacheWrite: p.input_cache_write,
    videoSecond: firstDefined(p.video_second, p.video_per_second, p.per_second, p.video)
  });
  const units = openAiPriceUnits(p);
  if (!price && units.length === 0) return undefined;
  return { ...(price ?? {}), ...(units.length > 0 ? { units } : {}) };
}

/** Vercel AI Gateway `getAvailableModels()` pricing block ($/token). */
export function vercelGatewayPrice(
  p:
    | {
        input?: unknown;
        output?: unknown;
        cachedInputTokens?: unknown;
        cacheCreationInputTokens?: unknown;
        input_cache_read?: unknown;
        input_cache_write?: unknown;
        video_duration_pricing?: unknown;
        video_token_pricing?: unknown;
      }
    | null
    | undefined
): ModelPrice | undefined {
  if (!p) return undefined;
  const price = buildPrice({
    input: p.input,
    output: p.output,
    cacheRead: firstDefined(p.cachedInputTokens, p.input_cache_read),
    cacheWrite: firstDefined(p.cacheCreationInputTokens, p.input_cache_write)
  });
  const videoDurationUnits = vercelVideoDurationPriceUnits(p.video_duration_pricing);
  const videoTokenUnits = vercelVideoTokenPriceUnits(p.video_token_pricing);
  const videoSecond = videoDurationUnits[0]?.price;
  const units = [...videoDurationUnits, ...videoTokenUnits];
  const withVideo = videoSecond === undefined ? price : { ...(price ?? {}), videoSecond };
  if (!withVideo && units.length === 0) return undefined;
  return { ...(withVideo ?? {}), ...(units.length > 0 ? { units } : {}) };
}

export const providerViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.enum(KNOWN_PROVIDER_TYPES),
  baseUrl: httpUrlSchema.optional(),
  extra: z.record(z.string(), z.string()).optional()
});
export type ProviderView = z.infer<typeof providerViewSchema>;

export const generationParamsViewSchema = z.object({
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  topP: z.number().optional(),
  reasoningEffort: z.string().optional()
});
export type GenerationParamsView = z.infer<typeof generationParamsViewSchema>;
/** Canonical generation params (single source). agent-core / sdk-atom / home all derive from
 *  this rather than redeclaring the shape. Identical to the wire view. */
export type GenerationParams = GenerationParamsView;

export const fallbackTargetViewSchema = z.union([
  z.object({ profile: z.string() }),
  z.object({ provider: z.string(), modelId: z.string() })
]);
export type FallbackTargetView = z.infer<typeof fallbackTargetViewSchema>;

export const profileViewSchema = z.object({
  alias: z.string(),
  routes: modelProfileRoutesSchema,
  params: generationParamsViewSchema,
  routeParams: z.partialRecord(modelRoleSchema, generationParamsViewSchema).optional(),
  fallbacks: z.array(fallbackTargetViewSchema)
});
export type ProfileView = z.infer<typeof profileViewSchema>;

export const credentialViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  authType: z.enum(['api_key', 'oauth', 'admin_api_key']),
  priority: z.number(),
  source: z.string(),
  baseUrl: httpUrlSchema.optional(),
  lastStatus: z.enum(['ok', 'error', 'unknown']),
  requestCount: z.number(),
  accessTokenPreview: z.string().optional() // masked tail, e.g. "…a1b2" — never the full token
});
export type CredentialView = z.infer<typeof credentialViewSchema>;

export const listProvidersResponseSchema = z.object({ providers: z.array(providerViewSchema) });
export type ListProvidersResponse = z.infer<typeof listProvidersResponseSchema>;

export const setProviderRequestSchema = z.object({ provider: providerViewSchema });
export type SetProviderRequest = z.infer<typeof setProviderRequestSchema>;

export const listProfilesResponseSchema = z.object({
  profiles: z.array(profileViewSchema),
  defaultAlias: z.string()
});
export type ListProfilesResponse = z.infer<typeof listProfilesResponseSchema>;

export const setProfileRequestSchema = z.object({ profile: profileViewSchema });
export type SetProfileRequest = z.infer<typeof setProfileRequestSchema>;

export const renameProfileRequestSchema = z.object({ alias: z.string() });
export type RenameProfileRequest = z.infer<typeof renameProfileRequestSchema>;

export const setDefaultProfileRequestSchema = z.object({ alias: z.string() });
export type SetDefaultProfileRequest = z.infer<typeof setDefaultProfileRequestSchema>;

export const getDefaultProfileResponseSchema = z.object({ alias: z.string() });
export type GetDefaultProfileResponse = z.infer<typeof getDefaultProfileResponseSchema>;

export const modelPriceSchema = z
  .object({
    input: z.number().optional(),
    output: z.number().optional(),
    cacheRead: z.number().optional(),
    cacheWrite: z.number().optional(),
    videoSecond: z.number().optional(),
    units: z
      .array(
        z.object({
          label: z.string(),
          price: z.number(),
          unit: z.string()
        })
      )
      .optional()
  })
  .partial();
export type ModelPrice = z.infer<typeof modelPriceSchema>;

// Model capabilities (drives the model-role picker).
// `kind` is the model's primary output role; `vision` is a separate input capability surfaced via
// `input` containing "image". Data comes from the provider's listModels when rich, else the
// models.dev catalog by id (mirroring price). embedding is detected by id (models.dev doesn't flag
// it via modality), so kind=embedding is authoritative even when modalities look like text→text.
export const modelKindSchema = z.enum([
  'chat',
  'image',
  'video',
  'speech',
  'embedding',
  'audio',
  'rerank',
  'transcription'
]);
export type ModelKind = z.infer<typeof modelKindSchema>;

/** A model-assignment slot. `chat` is special (it resolves to a profile, with params + fallback);
 *  the rest are profile role overrides. `vision` is a chat
 *  model that accepts image input. The role → required-capability mapping the UI filters on:
 *  chat=output⊇text · vision=input⊇image · image=output⊇image · speech=output⊇speech ·
 *  transcription=kind|output⊇transcription · embedding=kind. */
export const getRolesResponseSchema = z.object({ roles: modelRolesSchema });
export type GetRolesResponse = z.infer<typeof getRolesResponseSchema>;
export const setRolesRequestSchema = z.object({ roles: modelRolesSchema });
export type SetRolesRequest = z.infer<typeof setRolesRequestSchema>;
export const transcribeAudioRequestSchema = z.object({
  audioBase64: z.string().min(1).max(25_000_000),
  mediaType: z.string().min(1).max(200).optional(),
  language: z.string().min(1).max(64).optional()
});
export type TranscribeAudioRequest = z.infer<typeof transcribeAudioRequestSchema>;
export const transcribeAudioResponseSchema = z.object({ text: z.string() });
export type TranscribeAudioResponse = z.infer<typeof transcribeAudioResponseSchema>;

export const modelModalitiesSchema = z.object({
  input: z.array(z.string()).optional(),
  output: z.array(z.string()).optional(),
  reasoning: z.boolean().optional(),
  reasoningEfforts: z.array(z.string()).optional(),
  defaultReasoningEffort: z.string().optional(),
  toolCall: z.boolean().optional(),
  kind: modelKindSchema.optional()
});
export type ModelModalities = z.infer<typeof modelModalitiesSchema>;

export const modelInfoSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  price: modelPriceSchema.optional(), // USD per 1M tokens; provider-native price preferred, else catalog
  modalities: modelModalitiesSchema.optional(), // input/output modalities, flags, kind; provider-native preferred, else catalog
  contextLimit: z.number().int().positive().optional(),
  releaseDate: z.string().optional(),
  detailUrl: httpsUrlSchema.optional(),
  modelsDevUrl: httpsUrlSchema.optional()
});
export type ModelInfo = z.infer<typeof modelInfoSchema>;

export const listModelsResponseSchema = z.object({
  providerId: z.string(),
  models: z.array(modelInfoSchema)
});
export type ListModelsResponse = z.infer<typeof listModelsResponseSchema>;

export const listCredentialsResponseSchema = z.object({
  providerId: z.string(),
  credentials: z.array(credentialViewSchema)
});
export type ListCredentialsResponse = z.infer<typeof listCredentialsResponseSchema>;

// `providerId` travels in the path params; HTTP body derives via .omit().
export const addCredentialRequestSchema = z.object({
  providerId: z.string(),
  label: z.string(),
  authType: z.enum(['api_key', 'oauth', 'admin_api_key']),
  accessToken: z.string(),
  baseUrl: httpUrlSchema.optional(),
  priority: z.number().optional()
});
export type AddCredentialRequest = z.infer<typeof addCredentialRequestSchema>;

export const addCredentialBodySchema = addCredentialRequestSchema.omit({ providerId: true });

export const addCredentialResponseSchema = z.object({ id: z.string() });
export type AddCredentialResponse = z.infer<typeof addCredentialResponseSchema>;

// `providerId` + `credentialId` travel in path params; HTTP body derives via .pick().
export const testCredentialRequestSchema = z.object({
  providerId: z.string(),
  credentialId: z.string(),
  /** Model id to probe with; falls back to a profile that uses this provider. */
  modelId: z.string().optional()
});
export type TestCredentialRequest = z.infer<typeof testCredentialRequestSchema>;

export const deleteCredentialRequestSchema = testCredentialRequestSchema.pick({
  providerId: true,
  credentialId: true
});
export type DeleteCredentialRequest = z.infer<typeof deleteCredentialRequestSchema>;

export const testCredentialBodySchema = testCredentialRequestSchema.pick({ modelId: true }).optional();

export const testCredentialResponseSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().optional(),
  error: z.string().optional()
});
export type TestCredentialResponse = z.infer<typeof testCredentialResponseSchema>;

// Stateless "test before add": lists the provider's model catalogue (authenticated GET,
// no generation tokens spent) without persisting anything. On success, `models` is
// returned so the UI can immediately offer model choices.
export const testConnectionRequestSchema = z.object({
  provider: providerViewSchema,
  accessToken: z.string()
});
export type TestConnectionRequest = z.infer<typeof testConnectionRequestSchema>;

export const testConnectionResponseSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().optional(),
  error: z.string().optional(),
  models: z.array(modelInfoSchema).optional()
});
export type TestConnectionResponse = z.infer<typeof testConnectionResponseSchema>;
