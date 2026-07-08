import { expect, test } from 'bun:test';

import { computeCost, type ModelPrice } from '#/agent/index.ts';

// $/1M tokens — input $3, output $15, cache-read $0.30 (10%), cache-write $3.75 (1.25×).
const price: ModelPrice = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

test("provider-returned cost wins → source 'provider', exact", () => {
  const c = computeCost({ inputTokens: 100, outputTokens: 50 }, price, 0.0123);
  expect(c).toEqual({ usd: 0.0123, source: 'provider', approximate: false });
});

test('real usage × catalog price with cache discounts', () => {
  // 1M input (200k cache-read, 100k cache-write) + 500k output.
  const c = computeCost(
    { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 200_000, cacheWriteTokens: 100_000 },
    price
  );
  // nonCached input 800k×$3 + cacheRead 200k×$0.30 + cacheWrite 100k×$3.75 + output 500k×$15, per 1M.
  const expected = (800_000 * 3 + 200_000 * 0.3 + 100_000 * 3.75 + 500_000 * 15) / 1_000_000;
  expect(c.source).toBe('catalog_price');
  expect(c.approximate).toBe(true);
  expect(c.usd).toBeCloseTo(expected, 6);
});

test('missing cache classes contribute 0 (not unknown) — still a real cost', () => {
  const c = computeCost({ inputTokens: 100, outputTokens: 50 }, price);
  expect(c.source).toBe('catalog_price');
  expect(c.usd).toBeCloseTo((100 * 3 + 50 * 15) / 1_000_000, 9);
});

test('no cache-read rate → cache-read charged at input rate (conservative)', () => {
  const c = computeCost(
    { inputTokens: 100, outputTokens: 50, cacheReadTokens: 40 },
    { input: 3, output: 15 } // no cacheRead rate
  );
  // nonCached 60×3 + cacheRead 40×3 + output 50×15 = same as 100×3 + 50×15.
  expect(c.usd).toBeCloseTo((100 * 3 + 50 * 15) / 1_000_000, 9);
});

test("core tokens missing → 'unknown' (never fabricate cost)", () => {
  expect(computeCost({ outputTokens: 50 }, price).source).toBe('unknown'); // no inputTokens
  expect(computeCost({ inputTokens: 100, outputTokens: 50 }, price).source).toBe('catalog_price');
  expect(computeCost(undefined, price).source).toBe('unknown');
});

test("no price → 'unknown' (real tokens but no rate)", () => {
  const c = computeCost({ inputTokens: 100, outputTokens: 50 }, undefined);
  expect(c).toEqual({ source: 'unknown', approximate: true });
  expect(computeCost({ inputTokens: 100, outputTokens: 50 }, { input: 3 }).source).toBe('unknown'); // missing output rate
});
