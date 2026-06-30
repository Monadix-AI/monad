import type { ModelInfo, ModelModalities } from '@monad/sdk-atom';

import { createGateway } from '@ai-sdk/gateway';
import { vercelGatewayPrice } from '@monad/protocol';

import { defineAiSdkProvider } from './ai-sdk-adapter.ts';
import { PROVIDER_DESCRIPTORS } from './catalog.ts';

const VERCEL_MODELS_BASE_URL = 'https://ai-gateway.vercel.sh/v1';

interface VercelGatewayModelsResponse {
  data?: VercelGatewayModelRecord[];
}

interface VercelGatewayModelRecord {
  id: string;
  name?: string;
  context_window?: unknown;
  released?: unknown;
  type?: string;
  tags?: unknown;
  pricing?: Parameters<typeof vercelGatewayPrice>[0];
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

function tagSet(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0));
}

function modalitiesForModel(model: VercelGatewayModelRecord): ModelModalities {
  const tags = tagSet(model.tags);
  switch (model.type) {
    case 'embedding':
      return { kind: 'embedding', input: ['text'], output: ['embeddings'] };
    case 'image':
      return { kind: 'image', input: ['text', ...(tags.has('vision') ? ['image'] : [])], output: ['image'] };
    case 'video':
      return { kind: 'video', input: ['text', ...(tags.has('vision') ? ['image'] : [])], output: ['video'] };
    case 'speech':
      return { kind: 'speech', input: ['text'], output: ['speech'] };
    case 'transcription':
      return { kind: 'transcription', input: ['audio'], output: ['transcription'] };
    case 'reranking':
      return { kind: 'rerank', input: ['text'], output: ['rerank'] };
    case 'realtime':
      return { kind: 'audio', input: ['text', 'audio'], output: ['text', 'audio'] };
    default:
      return {
        kind: 'chat',
        input: ['text', ...(tags.has('vision') ? ['image'] : []), ...(tags.has('file-input') ? ['file'] : [])],
        output: ['text'],
        ...(tags.has('reasoning') ? { reasoning: true } : {}),
        ...(tags.has('tool-use') ? { toolCall: true } : {})
      };
  }
}

async function modelsHttpError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  return `Vercel AI Gateway /models failed: ${res.status}${text ? ` ${text.slice(0, 300)}` : ''}`;
}

export const vercelGatewayProviderAtom = defineAiSdkProvider({
  type: 'vercel-gateway',
  descriptor: PROVIDER_DESCRIPTORS['vercel-gateway'],

  build(call) {
    return createGateway({
      apiKey: call.credential.accessToken,
      baseURL: call.credential.baseUrl ?? call.provider.baseUrl,
      fetch: call.fetch
    }).languageModel(call.modelId);
  },

  buildEmbeddingModel(call) {
    return createGateway({
      apiKey: call.credential.accessToken,
      baseURL: call.credential.baseUrl ?? call.provider.baseUrl,
      fetch: call.fetch
    }).embeddingModel(call.modelId);
  },

  async listModels(provider, cred, fetch = globalThis.fetch) {
    const base = (cred?.baseUrl ?? provider.baseUrl ?? VERCEL_MODELS_BASE_URL).replace(/\/$/, '');
    const res = await fetch(`${base}/models`, {
      headers: cred?.accessToken ? { authorization: `Bearer ${cred.accessToken}` } : undefined
    });
    if (!res.ok) throw new Error(await modelsHttpError(res));
    const json = (await res.json()) as VercelGatewayModelsResponse;
    return (json.data ?? []).map((m): ModelInfo => {
      const price = vercelGatewayPrice(m.pricing);
      const contextLimit = positiveInteger(m.context_window);
      const releaseDate = releaseDateFromUnixSeconds(m.released);
      return {
        id: m.id,
        ...(m.name ? { label: m.name } : {}),
        ...(price ? { price } : {}),
        ...(contextLimit ? { contextLimit } : {}),
        ...(releaseDate ? { releaseDate } : {}),
        modalities: modalitiesForModel(m)
      };
    });
  }
});
