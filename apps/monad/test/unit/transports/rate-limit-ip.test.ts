import { expect, test } from 'bun:test';

import { createIpRateLimiter } from '#/transports/http/rate-limit.ts';

test('burst: an IP gets `capacity` requests then is throttled', () => {
  const limiter = createIpRateLimiter({ capacity: 3, refillPerSec: 0 });
  expect(limiter.allow('1.2.3.4')).toBeNull();
  expect(limiter.allow('1.2.3.4')).toBeNull();
  expect(limiter.allow('1.2.3.4')).toBeNull();
  expect(limiter.allow('1.2.3.4')).toBeGreaterThan(0);
});

test('buckets are isolated per IP', () => {
  const limiter = createIpRateLimiter({ capacity: 1, refillPerSec: 0 });
  expect(limiter.allow('10.0.0.1')).toBeNull();
  expect(limiter.allow('10.0.0.1')).toBeGreaterThan(0); // first IP exhausted
  expect(limiter.allow('10.0.0.2')).toBeNull(); // second IP unaffected
});

test('tokens refill over time', () => {
  let now = 0;
  const limiter = createIpRateLimiter({ capacity: 1, refillPerSec: 1000 }, () => now);
  expect(limiter.allow('9.9.9.9')).toBeNull();
  expect(limiter.allow('9.9.9.9')).toBeGreaterThan(0);
  now = 1;
  expect(limiter.allow('9.9.9.9')).toBeNull();
});
