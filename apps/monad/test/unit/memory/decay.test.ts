// Read-time confidence decay + recall eligibility.

import { expect, test } from 'bun:test';

import { decayedConfidence, isRecallEligible } from '@/services/memory/decay.ts';

const DAY = 86_400_000;
const now = 1_000 * DAY; // arbitrary fixed "now" (Date.now is avoided so the test is deterministic)

test('decayedConfidence halves over one half-life and is stable at age 0', () => {
  expect(decayedConfidence(1, now, now, 90)).toBe(1); // fresh
  expect(decayedConfidence(0.8, now - 90 * DAY, now, 90)).toBeCloseTo(0.4, 5); // one half-life
  expect(decayedConfidence(0.8, now - 180 * DAY, now, 90)).toBeCloseTo(0.2, 5); // two half-lives
});

test('decay is disabled for halfLifeDays <= 0 and never amplifies a future timestamp', () => {
  expect(decayedConfidence(0.8, now - 1000 * DAY, now, 0)).toBe(0.8); // off
  expect(decayedConfidence(0.8, now + 10 * DAY, now, 90)).toBe(0.8); // clamp age at 0
});

test('isRecallEligible drops contradicted laws and those decayed below the floor', () => {
  const fresh = { confidence: 0.9, updatedAt: now, contradictedBy: null };
  expect(isRecallEligible(fresh, now, { halfLifeDays: 90, floor: 0.3 })).toBe(true);

  const contradicted = { confidence: 0.9, updatedAt: now, contradictedBy: 'a fact' };
  expect(isRecallEligible(contradicted, now, { halfLifeDays: 90, floor: 0 })).toBe(false);

  // 0.9 × 0.5^(360/90) = 0.9/16 ≈ 0.056 < 0.3 → dropped
  const old = { confidence: 0.9, updatedAt: now - 360 * DAY, contradictedBy: null };
  expect(isRecallEligible(old, now, { halfLifeDays: 90, floor: 0.3 })).toBe(false);
  // same law with floor 0 stays eligible (decay alone never suppresses)
  expect(isRecallEligible(old, now, { halfLifeDays: 90, floor: 0 })).toBe(true);
});
