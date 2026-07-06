import type { ModelUsage, UsageLimits } from '@monad/sdk-atom';
import type { ProviderMetadata } from 'ai';

import { extractCacheWrite, extractProviderCost } from '@monad/sdk-atom';

/** Which HTTP response header style the provider uses for rate-limit info.
 *  'openai'     → x-ratelimit-remaining-{requests,tokens}, x-ratelimit-reset-{requests,tokens}
 *                 reset value is a duration string e.g. "6m0s" or "500ms"
 *  'anthropic'  → anthropic-ratelimit-{requests,tokens}-{remaining,reset}
 *                 reset value is an ISO 8601 datetime */
export type RateLimitHeaderStyle = 'openai' | 'anthropic';

function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// OpenAI-style reset header value: "6m0s", "500ms", "1s", "2h30m" etc. → epoch ms.
function parseDurationToResetMs(value: string): number | undefined {
  const now = Date.now();
  let ms = 0;
  const re = /(\d+(?:\.\d+)?)(h|m(?:s)?|s)/g;
  for (let match = re.exec(value); match !== null; match = re.exec(value)) {
    const n = parseFloat(match[1] ?? '');
    const unit = match[2];
    if (unit === 'h') ms += n * 3_600_000;
    else if (unit === 'm') ms += n * 60_000;
    else if (unit === 'ms') ms += n;
    else if (unit === 's') ms += n * 1_000;
  }
  return ms > 0 ? now + ms : undefined;
}

function extractRateLimitHeaders(headers: Headers, style: RateLimitHeaderStyle): UsageLimits | undefined {
  let requestsRemaining: number | undefined;
  let requestsLimit: number | undefined;
  let tokensRemaining: number | undefined;
  let tokensLimit: number | undefined;
  let inputTokensRemaining: number | undefined;
  let inputTokensLimit: number | undefined;
  let outputTokensRemaining: number | undefined;
  let outputTokensLimit: number | undefined;
  let resetAtMs: number | undefined;

  if (style === 'anthropic') {
    requestsRemaining = finite(Number(headers.get('anthropic-ratelimit-requests-remaining')));
    requestsLimit = finite(Number(headers.get('anthropic-ratelimit-requests-limit')));
    tokensRemaining = finite(Number(headers.get('anthropic-ratelimit-tokens-remaining')));
    tokensLimit = finite(Number(headers.get('anthropic-ratelimit-tokens-limit')));
    inputTokensRemaining = finite(Number(headers.get('anthropic-ratelimit-input-tokens-remaining')));
    inputTokensLimit = finite(Number(headers.get('anthropic-ratelimit-input-tokens-limit')));
    outputTokensRemaining = finite(Number(headers.get('anthropic-ratelimit-output-tokens-remaining')));
    outputTokensLimit = finite(Number(headers.get('anthropic-ratelimit-output-tokens-limit')));
    const resetRaw =
      headers.get('anthropic-ratelimit-tokens-reset') ??
      headers.get('anthropic-ratelimit-input-tokens-reset') ??
      headers.get('anthropic-ratelimit-requests-reset');
    if (resetRaw) {
      const t = Date.parse(resetRaw);
      if (!Number.isNaN(t)) resetAtMs = t;
    }
  } else {
    // openai style
    requestsRemaining = finite(Number(headers.get('x-ratelimit-remaining-requests')));
    requestsLimit = finite(Number(headers.get('x-ratelimit-limit-requests')));
    tokensRemaining = finite(Number(headers.get('x-ratelimit-remaining-tokens')));
    tokensLimit = finite(Number(headers.get('x-ratelimit-limit-tokens')));
    const resetRaw = headers.get('x-ratelimit-reset-tokens') ?? headers.get('x-ratelimit-reset-requests');
    if (resetRaw) resetAtMs = parseDurationToResetMs(resetRaw);
  }

  const out: UsageLimits = {
    requestsRemaining,
    requestsLimit,
    tokensRemaining,
    tokensLimit,
    inputTokensRemaining,
    inputTokensLimit,
    outputTokensRemaining,
    outputTokensLimit,
    resetAtMs
  };
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}

/** Wraps a fetch implementation to capture rate-limit response headers.
 *  The captured value is written into `sink.current` on the first successful response.
 *  `maxRetries: 0` in ai-sdk calls ensures at most one HTTP round-trip per invocation. */
export function wrapFetchForRateLimits(
  baseFetch: typeof globalThis.fetch,
  style: RateLimitHeaderStyle,
  sink: { current: UsageLimits | undefined }
): typeof globalThis.fetch {
  const wrapper = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init: Parameters<typeof globalThis.fetch>[1]
  ) => {
    const response = await baseFetch(input, init);
    const info = extractRateLimitHeaders(response.headers, style);
    if (info) sink.current = info;
    return response;
  };
  // Copy all extra properties (e.g. Bun's `preconnect`) so the wrapper is structurally identical.
  return Object.assign(wrapper, baseFetch);
}

export function toUsage(
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        cachedInputTokens?: number;
        reasoningTokens?: number;
      }
    | undefined,
  providerMetadata?: ProviderMetadata,
  rateLimitInfo?: UsageLimits
): ModelUsage | undefined {
  if (!usage) return undefined;
  const inputTokens = finite(usage.inputTokens);
  const outputTokens = finite(usage.outputTokens);
  const totalTokens =
    finite(usage.totalTokens) ??
    (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
  const out: ModelUsage = {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens: finite(usage.cachedInputTokens),
    cacheWriteTokens: extractCacheWrite(providerMetadata),
    reasoningTokens: finite(usage.reasoningTokens),
    costUsd: extractProviderCost(providerMetadata),
    ...(rateLimitInfo ? { rateLimitInfo } : {})
  };
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}
