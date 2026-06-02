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
  data?: Array<{
    id: string;
    name?: string;
    pricing?: { prompt?: unknown; completion?: unknown; input_cache_read?: unknown; input_cache_write?: unknown };
    architecture?: {
      modality?: string;
      input_modalities?: string[];
      output_modalities?: string[];
    };
  }>;
}

function kindFromArchitecture(
  modality: string | undefined,
  outputModalities: string[] | undefined,
  id: string
): ModelModalities['kind'] {
  const out = outputModalities ?? [];
  if (out.includes('embeddings') || modality?.includes('embeddings')) return 'embedding';
  if (out.includes('image') || modality?.includes('->image')) return 'image';
  // OpenRouter uses 'speech' (not 'audio') for TTS output modality.
  if (
    out.includes('audio') ||
    out.includes('speech') ||
    modality?.includes('->audio') ||
    modality?.includes('->speech')
  )
    return 'speech';
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
    const base = (cred?.baseUrl ?? provider.baseUrl ?? 'https://openrouter.ai').replace(/\/$/, '');
    const headers: Record<string, string> = {};
    if (cred?.accessToken) headers.authorization = `Bearer ${cred.accessToken}`;
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
    const toModelInfo = (m: NonNullable<OpenRouterModelsResponse['data']>[number]): ModelInfo => {
      const price = openAiPrice(m.pricing);
      const arch = m.architecture;
      const kind = kindFromArchitecture(arch?.modality, arch?.output_modalities, m.id);
      // Normalize OpenRouter's output_modalities to protocol values:
      // "speech" → "audio", "embeddings" is represented by kind alone.
      const output = arch?.output_modalities
        ?.map((v) => (v === 'speech' ? 'audio' : v === 'embeddings' ? null : v))
        .filter((v): v is string => v !== null);
      const modalities: ModelModalities = {
        kind,
        ...(arch?.input_modalities?.length ? { input: arch.input_modalities } : {}),
        ...(output?.length ? { output } : {})
      };
      return {
        id: m.id,
        ...(m.name ? { label: m.name } : {}),
        ...(price ? { price } : {}),
        modalities
      };
    };
    const models = (defaultJson.data ?? []).map(toModelInfo);
    const seen = new Set(models.map((m) => m.id));
    for (const extra of extraJsons) {
      for (const m of extra.data ?? []) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          models.push(toModelInfo(m));
        }
      }
    }
    return models;
  },

  // OpenRouter normalizes reasoning across upstreams behind one `reasoning.effort` knob; the
  // underlying model still has to support it, else the effort is ignored.
  reasoningOptions(effort, _maxThinkingTokens) {
    return { openrouter: { reasoning: { effort } } };
  },

  async getUsageLimits(provider, cred) {
    const base = (cred.baseUrl ?? provider.baseUrl ?? 'https://openrouter.ai').replace(/\/$/, '');
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
