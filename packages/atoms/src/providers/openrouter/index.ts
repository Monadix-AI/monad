import type { MetadataExtractor } from '@ai-sdk/openai-compatible';
import type { UsageLimits } from '@monad/sdk-atom';
import type { JSONValue } from 'ai';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';

import { defineAiSdkProvider } from '../ai-sdk-adapter/index.ts';
import { PROVIDER_DESCRIPTORS } from '../catalog.ts';
import { type OpenRouterProviderCall, openRouterApiOrigin } from './openrouter-http.ts';
import { openRouterRerank, openRouterSpeech, openRouterTranscribe, openRouterVideo } from './openrouter-media.ts';
import { listOpenRouterModels } from './openrouter-models.ts';

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

const openRouterKeyResponseSchema: z.ZodType<OpenRouterKeyResponse> = z.object({
  data: z
    .object({
      usage: z.unknown().optional(),
      usage_daily: z.unknown().optional(),
      usage_weekly: z.unknown().optional(),
      usage_monthly: z.unknown().optional(),
      limit: z.unknown().optional(),
      limit_remaining: z.unknown().optional(),
      rate_limit: z.object({ requests: z.unknown().optional(), interval: z.string().optional() }).optional()
    })
    .optional()
});

type ProviderMetadata = NonNullable<Awaited<ReturnType<MetadataExtractor['extractMetadata']>>>;

function toJsonValue(value: unknown): JSONValue | undefined {
  if (value === undefined) return undefined;
  return z.json().parse(JSON.parse(JSON.stringify(value)));
}

function extractOpenRouterMetadata(parsedBody: unknown): ProviderMetadata | undefined {
  const body = z.object({ usage: z.unknown().optional() }).safeParse(parsedBody);
  const usage = toJsonValue(body.success ? body.data.usage : undefined);
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

  buildImageModel(call) {
    return createOpenRouterProvider(call).imageModel(call.modelId);
  },

  buildEmbeddingModel(call) {
    return createOpenRouterProvider(call).embeddingModel(call.modelId);
  },

  generateVideo: openRouterVideo,

  generateSpeech: openRouterSpeech,

  transcribe: openRouterTranscribe,

  rerank: openRouterRerank,

  async listModels(provider, cred, fetch = globalThis.fetch) {
    return listOpenRouterModels(provider, cred, fetch);
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
      const json = openRouterKeyResponseSchema.parse(await res.json());
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
