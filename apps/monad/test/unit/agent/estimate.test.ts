import { expect, test } from 'bun:test';

import { estimateTokens, estimateTokensCached, TokenEstimator } from '@/agent/index.ts';

test('fresh estimator is approximate and uses the chars/4 seed', () => {
  const e = new TokenEstimator();
  expect(e.approximate).toBe(true);
  expect(e.ratio).toBe(4);
  expect(e.estimate('abcdefgh')).toBe(2); // 8 chars / 4
  expect(e.estimate('')).toBe(0);
});

test('observe() self-calibrates the ratio and clears approximate', () => {
  const e = new TokenEstimator();
  e.observe(8000, 1000); // sample ratio 8 → clamped to MAX 8
  expect(e.approximate).toBe(false);
  expect(e.ratio).toBe(8); // first sample sets it directly
  e.observe(2000, 1000); // sample ratio 2 → EMA pulls down
  expect(e.ratio).toBeLessThan(8);
  expect(e.ratio).toBeGreaterThanOrEqual(2);
});

test('observe() ignores empty/zero/undefined samples (presence ≠ value)', () => {
  const e = new TokenEstimator();
  e.observe(0, 100);
  e.observe(100, 0);
  e.observe(100, undefined);
  expect(e.approximate).toBe(true); // none were real samples
  expect(e.ratio).toBe(4);
});

test('ratio is clamped against absurd samples', () => {
  const e = new TokenEstimator();
  e.observe(1000, 1); // ratio 1000 → clamp to 8
  expect(e.ratio).toBe(8);
  const f = new TokenEstimator();
  f.observe(1, 1000); // ratio 0.001 → clamp to 2
  expect(f.ratio).toBe(2);
});

test('estimateTokensCached caches char length, keyed by id (stable across differing text)', () => {
  const first = estimateTokensCached('msg_cache', 'the original text here');
  // Same key, different text → returns the cached char-length result, not recomputed.
  const stale = estimateTokensCached('msg_cache', 'COMPLETELY different much much longer text body');
  expect(stale).toBe(first);
  // A fresh key reflects its own (longer) text.
  expect(estimateTokensCached('msg_other', 'COMPLETELY different much much longer text body')).toBeGreaterThan(first);
});

test('estimateTokens matches the global estimator on first computation', () => {
  expect(estimateTokensCached('k1', 'hello world')).toBe(estimateTokens('hello world'));
});
