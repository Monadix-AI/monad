// L3 inference loop + JSON parse + provenance grounding, over a real in-memory LawStore.

import { expect, test } from 'bun:test';

import { ConsolidationState } from '@/services/memory/consolidation-state.ts';
import { inferLawsForScopes, parseLaws } from '@/services/memory/law-infer.ts';
import { LawStore } from '@/services/memory/law-store.ts';

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;
// The model cites the short ref tags it was shown ([f1]/[e1]); a fabricated tag (f9) must be dropped.
const LAWS_JSON = JSON.stringify({
  laws: [
    { statement: 'User deploys with Bun, never Node', confidence: 0.9, support: ['f1', 'e1', 'f9'] },
    { statement: 'User prefers TypeScript strict mode', confidence: 0.7, support: ['f2'] }
  ]
});

test('parseLaws tolerates prose around the JSON and drops malformed rows', () => {
  const laws = parseLaws(`here you go:\n${LAWS_JSON}\ndone`);
  expect(laws?.map((l) => l.statement)).toEqual([
    'User deploys with Bun, never Node',
    'User prefers TypeScript strict mode'
  ]);
  expect(parseLaws('{"laws":[{"confidence":1}]}')).toEqual([]); // no statement → dropped
  expect(parseLaws('nope')).toBeNull();
});

function deps(store: LawStore, complete: () => Promise<string>, facts: string[]) {
  return {
    store,
    scopes: () => [{ scope: 'agent:a1', kind: 'agent' as const, id: 'a1' }],
    facts: async () => facts.map((content, i) => ({ id: `fid${i + 1}`, content })),
    graphItems: () => [{ id: 'eid1', text: 'Zeke —[works_on]→ Monad' }],
    complete,
    model: () => 'test',
    minInputs: 2,
    log: silent
  };
}

test('incremental: re-running with unchanged inputs skips the scope (no model call)', async () => {
  const store = new LawStore(':memory:');
  const state = new ConsolidationState(':memory:');
  let calls = 0;
  const model = async () => {
    calls++;
    return LAWS_JSON;
  };
  const facts = ['uses Bun', 'wrote TS'];
  const r1 = await inferLawsForScopes({ ...deps(store, model, facts), state });
  expect(r1.scopesProcessed).toBe(1);
  expect(r1.skipped).toBe(0);
  expect(calls).toBe(1);

  // same fact + edge ids → fingerprint matches → skipped, model not called again
  const r2 = await inferLawsForScopes({ ...deps(store, model, facts), state });
  expect(r2.scopesProcessed).toBe(0);
  expect(r2.skipped).toBe(1);
  expect(calls).toBe(1);

  // a new fact changes the fingerprint → re-derives
  const r3 = await inferLawsForScopes({ ...deps(store, model, [...facts, 'ships fast']), state });
  expect(r3.scopesProcessed).toBe(1);
  expect(calls).toBe(2);
});

test('infers laws and grounds support in real fact/edge ids (hallucinated refs dropped)', async () => {
  const store = new LawStore(':memory:');
  const r = await inferLawsForScopes(deps(store, async () => LAWS_JSON, ['uses Bun', 'wrote TS', 'ships fast']));
  expect(r.scopesProcessed).toBe(1);
  expect(r.laws).toBe(2);
  const laws = store.listLaws(['agent:a1']);
  const bun = laws.find((l) => l.statement.startsWith('User deploys'));
  // f1→fid1, e1→eid1 resolve; f9 was never shown → dropped (no hallucinated provenance).
  expect(bun?.support).toEqual(['fact:fid1', 'edge:eid1']);
  expect(laws.find((l) => l.statement.startsWith('User prefers'))?.support).toEqual(['fact:fid2']);
});

test('skips a scope with too little to generalize (model not called, laws untouched)', async () => {
  const store = new LawStore(':memory:');
  let called = false;
  const r = await inferLawsForScopes({
    store,
    scopes: () => [{ scope: 'agent:a1', kind: 'agent', id: 'a1' }],
    facts: async () => [], // 0 facts + 1 edge = 1 < minInputs(2)
    graphItems: () => [{ id: 'eid1', text: 'only one relation' }],
    complete: async () => {
      called = true;
      return LAWS_JSON;
    },
    model: () => 'test',
    minInputs: 2,
    log: silent
  });
  expect(called).toBe(false);
  expect(r.scopesProcessed).toBe(0);
});

test('re-running replaces a scope laws; unparseable output leaves them intact', async () => {
  const store = new LawStore(':memory:');
  await inferLawsForScopes(deps(store, async () => LAWS_JSON, ['a', 'b', 'c']));
  expect(store.listLaws(['agent:a1'])).toHaveLength(2);
  // a garbage model response must not wipe existing laws (parse fails → skip)
  await inferLawsForScopes(deps(store, async () => 'garbage', ['a', 'b', 'c']));
  expect(store.listLaws(['agent:a1'])).toHaveLength(2);
});
