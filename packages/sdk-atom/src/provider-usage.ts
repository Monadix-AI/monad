// Provider-metadata shape parsing — the single owner of "where in a provider's metadata blob the
// real cost and cache-write tokens live". Both monad's first-party providers (when normalizing
// streamed usage) and the daemon's observability layer (when parsing the persisted metadata JSON)
// read these, so the key paths can't silently drift between the two. Pure + ai-sdk-free: the
// metadata is treated as a plain nested record.

import { z } from 'zod';

type MetadataShape = Record<string, unknown> | undefined;
const providerMetadataSchema = z.record(z.string(), z.unknown());

function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Cache-write (prompt-caching creation) tokens, reported by Anthropic and Bedrock under different keys. */
export function extractCacheWrite(meta: MetadataShape): number | undefined {
  if (!meta) return undefined;
  const anthropic = meta.anthropic as { cacheCreationInputTokens?: unknown } | undefined;
  const bedrock = meta.bedrock as { usage?: { cacheWriteInputTokens?: unknown } } | undefined;
  return finite(anthropic?.cacheCreationInputTokens) ?? finite(bedrock?.usage?.cacheWriteInputTokens);
}

/** Real provider-reported cost in USD (OpenRouter surfaces it under `openrouter.usage.cost`). */
export function extractProviderCost(meta: MetadataShape): number | undefined {
  if (!meta) return undefined;
  const openrouter = meta.openrouter as { usage?: { cost?: unknown } } | undefined;
  return finite(openrouter?.usage?.cost);
}

/** Parse a persisted provider-metadata JSON blob into provider-reported cost + cache-write tokens.
 *  Returns {} on malformed input. */
export function usageFromProviderMetadataJson(json: string): { costUsd?: number; cacheWriteTokens?: number } {
  try {
    const meta = providerMetadataSchema.parse(JSON.parse(json));
    return { costUsd: extractProviderCost(meta), cacheWriteTokens: extractCacheWrite(meta) };
  } catch {
    return {};
  }
}
