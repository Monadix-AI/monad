import type { OpenRouterModelRecord } from './openrouter-models.ts';

import { openRouterDetailsUrl, openRouterModelPageUrl } from './openrouter-http.ts';

export interface OpenRouterPricing {
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

export interface OpenRouterModelDetailsResponse {
  data?: {
    endpoints?: Array<{
      pricing?: OpenRouterPricing;
    }>;
  };
}

export function numericPrice(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number.parseFloat(value) : typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function hasPositiveNonTokenPrice(pricing: OpenRouterPricing | undefined): boolean {
  if (!pricing) return false;
  return Object.entries(pricing).some(([key, value]) => {
    if (key === 'prompt' || key === 'completion' || key === 'input_cache_read' || key === 'input_cache_write') {
      return false;
    }
    const n = numericPrice(value);
    return n !== undefined && n > 0;
  });
}

export function shouldFetchEndpointPricing(model: OpenRouterModelRecord): boolean {
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

export async function fetchEndpointPricing(
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

export async function fetchModelPagePricing(
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

export function priceFromOpenRouterModelPage(html: string): OpenRouterPricing | undefined {
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

export function mergePricing(
  modelPricing: OpenRouterPricing | undefined,
  endpointPricing: OpenRouterPricing | undefined
): OpenRouterPricing | undefined {
  if (!modelPricing && !endpointPricing) return undefined;
  return { ...(modelPricing ?? {}), ...(endpointPricing ?? {}) };
}
