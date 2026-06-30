// Per-scope consolidation fingerprint store + the order-independent fingerprint.

import { expect, test } from 'bun:test';

import { ConsolidationState, fingerprint } from '@/services/memory/consolidation-state.ts';

test('fingerprint is order-independent and changes with the set', () => {
  expect(fingerprint(['a', 'b', 'c'])).toBe(fingerprint(['c', 'a', 'b']));
  expect(fingerprint(['a', 'b'])).not.toBe(fingerprint(['a', 'b', 'c']));
  expect(fingerprint([])).toBe(fingerprint([]));
});

test('ConsolidationState round-trips and upserts by key', () => {
  const s = new ConsolidationState(':memory:');
  expect(s.get('l1:global')).toBeNull();
  s.set('l1:global', 'abc');
  expect(s.get('l1:global')).toBe('abc');
  s.set('l1:global', 'def'); // upsert
  expect(s.get('l1:global')).toBe('def');
  expect(s.get('l3:global')).toBeNull(); // independent key
});
