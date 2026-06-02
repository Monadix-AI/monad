/** Token-bucket rate limit config: `capacity` burst, refilled at `refillPerSec`. */
export interface RateLimitConfig {
  capacity: number;
  refillPerSec: number;
}

/** Base rate limit bucket state. */
export interface RateLimitBucket {
  tokens: number;
  lastRefillMs: number;
}

/** Rate limit bucket with cached capacity and refill rate. */
export interface RateLimitBucketState extends RateLimitBucket {
  capacity: number;
  refillPerMs: number;
}
