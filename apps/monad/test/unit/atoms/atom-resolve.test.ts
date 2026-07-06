import { expect, test } from 'bun:test';

import { type AtomCandidate, qualifiedAtomName, resolveAtomPins } from '@/atoms/resolve.ts';

const c = (bareId: string, packId: string): AtomCandidate => ({ bareId, packId });

test('no collision → each bare id maps to its sole pack, no collisions reported', () => {
  const r = resolveAtomPins([c('search', 'a'), c('deploy', 'b')]);
  expect([...r.winners]).toEqual([
    ['search', 'a'],
    ['deploy', 'b']
  ]);
});

test('collision → first-wins by load order; the rest are shadowed', () => {
  const r = resolveAtomPins([c('search', 'a'), c('search', 'b'), c('search', 'c')]);
  expect(r.winners.get('search')).toBe('a');
  expect(r.collisions).toEqual([{ bareId: 'search', winner: 'a', shadowed: ['b', 'c'] }]);
});

test('a pin overrides first-wins when the pinned pack provides the id', () => {
  const r = resolveAtomPins([c('search', 'a'), c('search', 'b')], { search: 'b' });
  expect(r.winners.get('search')).toBe('b');
  expect(r.collisions[0]).toEqual({ bareId: 'search', winner: 'b', shadowed: ['a'] });
});

test('a pin to an absent pack falls back to first-wins', () => {
  const r = resolveAtomPins([c('search', 'a'), c('search', 'b')], { search: 'gone' });
  expect(r.winners.get('search')).toBe('a');
});

test('qualifiedAtomName builds the always-addressable escape-hatch name', () => {
  expect(qualifiedAtomName('acme', 'search')).toBe('acme__search');
  expect(qualifiedAtomName('acme', 'deploy', '.')).toBe('acme.deploy');
});
