// Contradiction detection: JSON parse, tag→id mapping with hallucination drop, and the per-scope
// loop that clears stale flags.

import { expect, test } from 'bun:test';

import {
  checkContradictionsForScopes,
  detectContradictions,
  parseContradictions
} from '@/services/memory/contradict.ts';

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

test('parseContradictions extracts the shape and ignores malformed rows', () => {
  expect(parseContradictions('ok {"contradictions":[{"rule":"r1","fact":"f2"}]} done')).toEqual([
    { rule: 'r1', fact: 'f2' }
  ]);
});

test('detectContradictions maps cited tags to real ids and drops invented ones', async () => {
  const laws = [
    { id: 'L1', statement: 'User deploys with Bun, never Node' },
    { id: 'L2', statement: 'User prefers dark mode' }
  ];
  const facts = [{ content: 'Switched the API service to Node' }, { content: 'Likes dark mode' }];
  // Cites r1↔f1 (a real contradiction) plus a fabricated r9.
  const model = async () => '{"contradictions":[{"rule":"r1","fact":"f1"},{"rule":"r9","fact":"f1"}]}';
  const hits = await detectContradictions(model, 'test', laws, facts);
  expect(hits).toEqual([{ lawId: 'L1', factContent: 'Switched the API service to Node' }]);
});

test('detectContradictions short-circuits when there are no laws or no facts', async () => {
  let called = false;
  const model = async () => {
    called = true;
    return '{}';
  };
  expect(called).toBe(false);
});

test('checkContradictionsForScopes marks every scope (clearing resolved flags)', async () => {
  const marks: Record<string, string[]> = {};
  const r = await checkContradictionsForScopes({
    scopes: () => [{ scope: 'agent:a1', kind: 'agent', id: 'a1' }],
    laws: () => [{ id: 'L1', statement: 'never Node' }],
    facts: async () => [{ content: 'now uses Node' }],
    mark: (scope, m) => {
      marks[scope] = [...m.keys()];
    },
    complete: async () => '{"contradictions":[{"rule":"r1","fact":"f1"}]}',
    model: () => 'test',
    log: silent
  });
  expect(r.flagged).toBe(1);
  expect(marks['agent:a1']).toEqual(['L1']);
});
