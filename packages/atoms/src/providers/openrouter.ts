import type { MetadataExtractor } from '@ai-sdk/openai-compatible';
import type {
  ModelInfo,
  ModelModalities,
  ProviderCredential,
  ResolvedProviderConfig,
  UsageLimits
} from '@monad/sdk-atom';
import type { JSONValue } from 'ai';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { openAiPrice } from '@monad/protocol';

import { defineAiSdkProvider } from './ai-sdk-adapter.ts';
import { PROVIDER_DESCRIPTORS } from './catalog.ts';

interface OpenRouterKeyResponse {
  data?: {
    usage?: unknown;
    usage_daily?: unknown;
    usage_weekly?: unknown;
    usage_monthly?: unknown;
    limit?: unknown;
    limit_remaining?: unknown;
    rate_limit?: { requests?: unknown; interval?: string };
  };
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModelRecord[];
}

interface OpenRouterModelRecord {
  id: string;
  name?: string;
  created?: unknown;
  context_length?: unknown;
  pricing?: OpenRouterPricing;
  reasoning?: {
    mandatory?: unknown;
    default_enabled?: unknown;
    supported_efforts?: unknown;
    default_effort?: unknown;
  };
  supported_parameters?: unknown;
  top_provider?: {
    context_length?: unknown;
  };
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
  links?: {
    details?: unknown;
  };
}

interface OpenRouterPricing {
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
  song?: unknown;
  image_output?: unknown;
}

interface OpenRouterModelDetailsResponse {
  data?: {
    endpoints?: Array<{
      pricing?: OpenRouterPricing;
    }>;
  };
}

function kindFromArchitecture(
  modality: string | undefined,
  outputModalities: string[] | undefined,
  id: string
): ModelModalities['kind'] {
  const out = outputModalities ?? [];
  if (out.includes('embeddings') || modality?.includes('embeddings')) return 'embedding';
  if (out.includes('video') || modality?.includes('->video')) return 'video';
  if (out.includes('image') || modality?.includes('->image')) return 'image';
  // OpenRouter uses 'speech' (not 'audio') for TTS output modality.
  if (out.includes('speech') || modality?.includes('->speech')) return 'speech';
  if (out.includes('audio') || modality?.includes('->audio')) return 'audio';
  if (out.includes('rerank') || modality?.includes('->rerank')) return 'rerank';
  if (out.includes('transcription') || modality?.includes('->transcription')) return 'transcription';
  if (/embed/i.test(id)) return 'embedding';
  return 'chat';
}

type OpenRouterProviderCall = {
  provider: ResolvedProviderConfig;
  credential: ProviderCredential;
  fetch?: typeof globalThis.fetch;
};
type ProviderMetadata = NonNullable<Awaited<ReturnType<MetadataExtractor['extractMetadata']>>>;

function toJsonValue(value: unknown): JSONValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as JSONValue;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return strings.length ? strings : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : typeof value === 'number' ? value : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function releaseDateFromUnixSeconds(value: unknown): string | undefined {
  const seconds = typeof value === 'string' ? Number.parseFloat(value) : typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function numericPrice(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number.parseFloat(value) : typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function hasPositiveNonTokenPrice(pricing: OpenRouterPricing | undefined): boolean {
  if (!pricing) return false;
  return Object.entries(pricing).some(([key, value]) => {
    if (key === 'prompt' || key === 'completion' || key === 'input_cache_read' || key === 'input_cache_write') {
      return false;
    }
    const n = numericPrice(value);
    return n !== undefined && n > 0;
  });
}

function shouldFetchEndpointPricing(model: OpenRouterModelRecord): boolean {
  if (typeof model.links?.details !== 'string') return false;
  const output = model.architecture?.output_modalities ?? [];
  const shouldUseDetailPricingFallback =
    output.includes('image') ||
    output.includes('video') ||
    output.includes('rerank') ||
    output.includes('audio') ||
    output.includes('speech') ||
    output.includes('transcription') ||
    !!model.architecture?.modality?.includes('->image') ||
    !!model.architecture?.modality?.includes('->video') ||
    !!model.architecture?.modality?.includes('->rerank') ||
    !!model.architecture?.modality?.includes('->audio') ||
    !!model.architecture?.modality?.includes('->speech') ||
    !!model.architecture?.modality?.includes('->transcription');
  return shouldUseDetailPricingFallback && !hasPositiveNonTokenPrice(model.pricing);
}

async function fetchEndpointPricing(
  base: string,
  model: OpenRouterModelRecord,
  headers: Record<string, string>,
  fetch: typeof globalThis.fetch
): Promise<OpenRouterPricing | undefined> {
  const details = model.links?.details;
  if (typeof details !== 'string') return undefined;
  const detailsUrl = openRouterDetailsUrl(base, details);
  if (!detailsUrl) return fetchModelPagePricing(base, model, fetch);
  let endpointPricing: OpenRouterPricing | undefined;
  try {
    const res = await fetch(detailsUrl, { headers });
    if (!res.ok) return undefined;
    const json = (await res.json()) as OpenRouterModelDetailsResponse;
    endpointPricing = json.data?.endpoints?.find((endpoint) => endpoint.pricing)?.pricing;
  } catch {
    return fetchModelPagePricing(base, model, fetch);
  }
  if (hasPositiveNonTokenPrice(endpointPricing)) return endpointPricing;
  const pagePricing = await fetchModelPagePricing(base, model, fetch);
  if (hasPositiveNonTokenPrice(pagePricing)) return pagePricing;
  return mergePricing(endpointPricing, pagePricing);
}

async function fetchModelPagePricing(
  _base: string,
  model: OpenRouterModelRecord,
  fetch: typeof globalThis.fetch
): Promise<OpenRouterPricing | undefined> {
  try {
    const res = await fetch(openRouterModelPageUrl(model.id));
    if (!res.ok) return undefined;
    return priceFromOpenRouterModelPage(await res.text());
  } catch {
    return undefined;
  }
}

function priceFromOpenRouterModelPage(html: string): OpenRouterPricing | undefined {
  const match = html.match(
    /(?:from\s*)?\$([0-9]+(?:\.[0-9]+)?)\s*<[^>]*>\s*\/(search|second|seconds|minute|minutes|hour|hours|song|songs)\s*</i
  );
  if (!match?.[1] || !match[2]) return undefined;
  const unit = match[2].toLowerCase();
  if (unit === 'search') return { search: match[1] };
  if (unit === 'minute' || unit === 'minutes') return { per_minute: match[1] };
  if (unit === 'hour' || unit === 'hours') return { per_hour: match[1] };
  if (unit === 'song' || unit === 'songs') return { song: match[1] };
  return { video_second: match[1] };
}

function mergePricing(
  modelPricing: OpenRouterPricing | undefined,
  endpointPricing: OpenRouterPricing | undefined
): OpenRouterPricing | undefined {
  if (!modelPricing && !endpointPricing) return undefined;
  return { ...(modelPricing ?? {}), ...(endpointPricing ?? {}) };
}

function extractOpenRouterMetadata(parsedBody: unknown): ProviderMetadata | undefined {
  const body = parsedBody as { usage?: unknown } | undefined;
  const usage = toJsonValue(body?.usage);
  return usage === undefined ? undefined : { openrouter: { usage } };
}

const openrouterMetadataExtractor: MetadataExtractor = {
  async extractMetadata({ parsedBody }) {
    return extractOpenRouterMetadata(parsedBody);
  },
  createStreamExtractor() {
    let usage: JSONValue | undefined;
    return {
      processChunk(parsedChunk) {
        const metadata = extractOpenRouterMetadata(parsedChunk);
        if (metadata?.openrouter && typeof metadata.openrouter === 'object' && 'usage' in metadata.openrouter) {
          usage = metadata.openrouter.usage;
        }
      },
      buildMetadata() {
        return usage === undefined ? undefined : { openrouter: { usage } };
      }
    };
  }
};

function createOpenRouterProvider(call: OpenRouterProviderCall) {
  return createOpenAICompatible({
    name: call.provider.id,
    apiKey: call.credential.accessToken,
    baseURL: call.credential.baseUrl ?? call.provider.baseUrl ?? 'https://openrouter.ai/api/v1',
    fetch: call.fetch,
    includeUsage: true,
    metadataExtractor: openrouterMetadataExtractor,
    transformRequestBody: (body) => ({ ...body, usage: { include: true } })
  });
}

function openRouterApiOrigin(baseUrl: string | undefined): string {
  return (baseUrl ?? 'https://openrouter.ai').replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
}

function openRouterDetailsUrl(base: string, details: string): string | undefined {
  try {
    const baseUrl = new URL(base);
    const detailsUrl = new URL(details, baseUrl);
    if (detailsUrl.origin !== baseUrl.origin) return undefined;
    return detailsUrl.toString();
  } catch {
    return undefined;
  }
}

function openRouterModelPageUrl(modelId: string): string {
  return new URL(`/${modelId}`, 'https://openrouter.ai').toString();
}

async function assertOpenRouterKey(
  base: string,
  cred: ProviderCredential,
  fetch: typeof globalThis.fetch
): Promise<void> {
  if (!cred.accessToken) throw new Error('OpenRouter auth failed: missing API key');
  const res = await fetch(`${base}/api/v1/auth/key`, {
    headers: { authorization: `Bearer ${cred.accessToken}` }
  });
  if (res.ok) return;
  throw new Error(`OpenRouter auth failed: ${res.status}`);
}

export const openrouterProviderAtom = defineAiSdkProvider({
  type: 'openrouter',
  descriptor: PROVIDER_DESCRIPTORS.openrouter,
  rateLimitHeaderStyle: 'openai',

  build(call) {
    return createOpenRouterProvider(call).languageModel(call.modelId);
  },

  buildEmbeddingModel(call) {
    return createOpenRouterProvider(call).embeddingModel(call.modelId);
  },

  async listModels(provider, cred, fetch = globalThis.fetch) {
    if (!cred) throw new Error('OpenRouter auth failed: missing credential');
    const base = openRouterApiOrigin(cred.baseUrl ?? provider.baseUrl);
    const headers: Record<string, string> = {};
    await assertOpenRouterKey(base, cred, fetch);
    headers.authorization = `Bearer ${cred.accessToken}`;
    // OpenRouter's default /models only returns text/chat models. All other categories require
    // separate ?output_modalities= requests (counts as of 2026-06):
    //   image (+25), audio (4, also in default), speech/TTS (9), embeddings (26),
    //   video (14), rerank (4), transcription (10). All requests run in parallel.
    const EXTRA_MODALITIES = ['image', 'audio', 'speech', 'embeddings', 'video', 'rerank', 'transcription'] as const;
    const [defaultRes, ...extraResponses] = await Promise.all([
      fetch(`${base}/api/v1/models`, { headers }),
      ...EXTRA_MODALITIES.map((mod) => fetch(`${base}/api/v1/models?output_modalities=${mod}`, { headers }))
    ]);
    if (!defaultRes.ok) throw new Error(`OpenRouter /models failed: ${defaultRes.status}`);
    const safeJson = async (res: Response) =>
      res.ok ? ((await res.json()) as OpenRouterModelsResponse) : { data: [] };
    const [defaultJson, ...extraJsons] = await Promise.all([
      defaultRes.json() as Promise<OpenRouterModelsResponse>,
      ...extraResponses.map(safeJson)
    ]);
    const rawModels = [...(defaultJson.data ?? [])];
    const seenRaw = new Set(rawModels.map((model) => model.id));
    for (const extra of extraJsons) {
      for (const model of extra.data ?? []) {
        if (!seenRaw.has(model.id)) {
          seenRaw.add(model.id);
          rawModels.push(model);
        }
      }
    }
    const endpointPricing = new Map<string, OpenRouterPricing>();
    await Promise.all(
      rawModels.map(async (model) => {
        if (!shouldFetchEndpointPricing(model)) return;
        const pricing = await fetchEndpointPricing(base, model, headers, fetch);
        if (pricing) endpointPricing.set(model.id, pricing);
      })
    );
    const toModelInfo = (m: OpenRouterModelRecord): ModelInfo => {
      const detailedPricing = endpointPricing.get(m.id);
      const price = openAiPrice(
        detailedPricing && hasPositiveNonTokenPrice(detailedPricing)
          ? detailedPricing
          : mergePricing(m.pricing, detailedPricing)
      );
      const arch = m.architecture;
      const contextLimit = positiveInteger(m.context_length) ?? positiveInteger(m.top_provider?.context_length);
      const releaseDate = releaseDateFromUnixSeconds(m.created);
      const kind = kindFromArchitecture(arch?.modality, arch?.output_modalities, m.id);
      // OpenRouter reports audio and speech separately; keep speech distinct for TTS role matching.
      const output = arch?.output_modalities?.filter((v) => v.length > 0);
      const supportedParameters = stringArray(m.supported_parameters);
      const reasoningEfforts = stringArray(m.reasoning?.supported_efforts);
      const defaultReasoningEffort =
        typeof m.reasoning?.default_effort === 'string' && m.reasoning.default_effort.length
          ? m.reasoning.default_effort
          : undefined;
      const reasoning =
        !!m.reasoning || !!supportedParameters?.some((param) => param === 'reasoning' || param === 'reasoning_effort');
      const modalities: ModelModalities = {
        kind,
        ...(arch?.input_modalities?.length ? { input: arch.input_modalities } : {}),
        ...(output?.length ? { output } : {}),
        ...(reasoning ? { reasoning: true } : {}),
        ...(reasoningEfforts ? { reasoningEfforts } : {}),
        ...(defaultReasoningEffort ? { defaultReasoningEffort } : {})
      };
      return {
        id: m.id,
        ...(m.name ? { label: m.name } : {}),
        ...(price ? { price } : {}),
        ...(contextLimit ? { contextLimit } : {}),
        ...(releaseDate ? { releaseDate } : {}),
        detailUrl: openRouterModelPageUrl(m.id),
        modalities
      };
    };
    return rawModels.map((model) => toModelInfo(model));
  },

  // OpenRouter normalizes reasoning across upstreams behind one `reasoning.effort` knob; the
  // underlying model still has to support it, else the effort is ignored.
  reasoningOptions(effort, _maxThinkingTokens) {
    return { openrouter: { reasoning: { effort } } };
  },

  async getUsageLimits(provider, cred) {
    const base = openRouterApiOrigin(cred.baseUrl ?? provider.baseUrl);
    try {
      const res = await fetch(`${base}/api/v1/auth/key`, {
        headers: { authorization: `Bearer ${cred.accessToken}` }
      });
      if (!res.ok) return undefined;
      const json = (await res.json()) as OpenRouterKeyResponse;
      const d = json.data;
      if (!d) return undefined;
      const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      const out: UsageLimits = {
        creditUsd: finite(d.limit_remaining),
        creditLimit: finite(d.limit),
        spendUsdDay: finite(d.usage_daily),
        spendUsdWeek: finite(d.usage_weekly),
        spendUsdMonth: finite(d.usage_monthly)
      };
      return Object.values(out).some((v) => v !== undefined) ? out : undefined;
    } catch {
      return undefined;
    }
  }
});
