import type { Instance } from '#/channels/types.ts';

import { sweepIdleBuckets } from '#/channels/helpers.ts';

/** Soft cap on per-user rate-limit buckets before an idle-bucket sweep runs. */
const BUCKET_CAP = 1000;

export function rateOk(inst: Instance, userId: string): boolean {
  const limit = inst.config.rateLimitPerMin;
  const now = Date.now();
  // `buckets` keeps one entry per user and is driven by external (channel-user) ids, so on an
  // allow-all channel it would grow without bound. Amortized sweep: when it gets large, drop
  // every bucket that has fully refilled — those are indistinguishable from a fresh default,
  // so dropping them is lossless and bounds the map to users currently being throttled.
  if (inst.buckets.size > BUCKET_CAP) sweepIdleBuckets(inst.buckets, now, limit);
  const b = inst.buckets.get(userId) ?? { tokens: limit, last: now };
  b.tokens = Math.min(limit, b.tokens + ((now - b.last) / 60_000) * limit);
  b.last = now;
  inst.buckets.set(userId, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

export async function serialize<T>(inst: Instance, key: string, fn: () => Promise<T>): Promise<T> {
  const prev = inst.locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const guarded = run.then(
    () => {},
    () => {}
  );
  inst.locks.set(key, guarded);
  try {
    return await run;
  } finally {
    if (inst.locks.get(key) === guarded) inst.locks.delete(key);
  }
}
