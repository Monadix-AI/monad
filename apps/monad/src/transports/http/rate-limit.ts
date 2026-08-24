import type { RateLimitBucket, RateLimitConfig } from '#/transports/types.ts';

type Bucket = RateLimitBucket;

export interface IpRateLimiter {
  /**
   * Spend one token for `ip`.
   * Returns `null` when the request is allowed, or the number of seconds the caller
   * should wait before retrying (for use in a `Retry-After` response header).
   */
  allow(ip: string): null | number;
}

export function createIpRateLimiter(
  { capacity, refillPerSec }: RateLimitConfig,
  now: () => number = Date.now
): IpRateLimiter {
  // Keyed by peer IP. Bounded in practice by the number of distinct remote peers (TCP
  // source addresses can't be spoofed on an established connection).
  const buckets = new Map<string, Bucket>();
  const refillPerMs = refillPerSec / 1000;

  return {
    allow(ip: string): null | number {
      const currentTime = now();
      let bucket = buckets.get(ip);
      if (!bucket) {
        bucket = { tokens: capacity, lastRefillMs: currentTime };
        buckets.set(ip, bucket);
      }
      bucket.tokens = Math.min(capacity, bucket.tokens + (currentTime - bucket.lastRefillMs) * refillPerMs);
      bucket.lastRefillMs = currentTime;
      if (bucket.tokens < 1) {
        const waitMs = (1 - bucket.tokens) / refillPerMs;
        return Math.ceil(waitMs / 1000);
      }
      bucket.tokens -= 1;
      return null;
    }
  };
}
