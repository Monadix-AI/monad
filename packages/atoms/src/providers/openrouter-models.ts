import type { ModelInfo, ModelModalities, ProviderCredential, ResolvedProviderConfig } from '@monad/sdk-atom';

import { openAiPrice } from '@monad/protocol';

import { assertOpenRouterKey, openRouterApiOrigin, openRouterModelPageUrl } from './openrouter-http.ts';
import {
  fetchEndpointPricing,
  hasPositiveNonTokenPrice,
  mergePricing,
  type OpenRouterPricing,
  shouldFetchEndpointPricing
} from './openrouter-pricing.ts';

export interface OpenRouterModelsResponse {
  data?: OpenRouterModelRecord[];
}

export interface OpenRouterModelRecord {
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

export function kindFromArchitecture(
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

export function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return strings.length ? strings : undefined;
}

export function positiveInteger(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : typeof value === 'number' ? value : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function releaseDateFromUnixSeconds(value: unknown): string | undefined {
  const seconds = typeof value === 'string' ? Number.parseFloat(value) : typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export async function listOpenRouterModels(
  provider: ResolvedProviderConfig,
  cred: ProviderCredential | undefined,
  fetch: typeof globalThis.fetch = globalThis.fetch
): Promise<ModelInfo[]> {
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
  const safeJson = async (res: Response) => (res.ok ? ((await res.json()) as OpenRouterModelsResponse) : { data: [] });
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
}
