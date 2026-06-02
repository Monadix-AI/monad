import type { RateLimitBucketState, RateLimitConfig } from '@/transports/types.ts';

export type TokenBucket = RateLimitBucketState;

/**
 * Spend one token. Returns false when the bucket is empty (caller should reject the
 * request). The bucket refills continuously, so a steady-state caller under
 * `refillPerSec` never blocks while a flood is throttled after the initial burst.
 */
export function consumeToken(bucket: TokenBucket): boolean {
  const now = Date.now();
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + (now - bucket.lastRefillMs) * bucket.refillPerMs);
  bucket.lastRefillMs = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/**
 * @param rateLimit - When provided, the connection is rate-limited (browser-facing WS).
 *                    Omit for trusted local transports (stdio) so they run unthrottled.
 */
export function createTokenBucket(rateLimit?: RateLimitConfig): TokenBucket | undefined {
  return rateLimit
    ? {
        tokens: rateLimit.capacity,
        capacity: rateLimit.capacity,
        refillPerMs: rateLimit.refillPerSec / 1000,
        lastRefillMs: Date.now()
      }
    : undefined;
}
