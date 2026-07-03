// Lexical law matching for the /why provenance query.

import { expect, test } from 'bun:test';

import { matchLaws } from '@/services/memory/explain.ts';

const laws = [
  { statement: 'User deploys with Bun, never Node' },
  { statement: 'User prefers TypeScript strict mode' },
  { statement: 'Always run tests before committing' }
];

test('matchLaws ranks by query/statement word overlap', () => {
  expect(matchLaws(laws, 'why bun never node?').map((l) => l.statement)).toEqual(['User deploys with Bun, never Node']);
  // "user" is shared by two laws, so the more-overlapping one (TypeScript) sorts first.
  expect(matchLaws(laws, 'typescript strict user', 2).map((l) => l.statement)).toEqual([
    'User prefers TypeScript strict mode',
    'User deploys with Bun, never Node'
  ]);
});

test('matchLaws returns nothing for a query that shares no words', () => {
  expect(matchLaws(laws, 'kubernetes helm charts')).toEqual([]);
  expect(matchLaws(laws, '')).toEqual([]);
  expect(matchLaws(laws, '!!!')).toEqual([]);
});

test('matchLaws caps results at the limit', () => {
  expect(matchLaws(laws, 'user run tests deploy', 1)).toHaveLength(1);
});
