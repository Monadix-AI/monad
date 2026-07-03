// LawStore (bun:sqlite, in-memory): wholesale per-scope replace, dedup, scope-isolated listing.

import { expect, test } from 'bun:test';

import { LawStore } from '@/services/memory/law-store.ts';

const fresh = () => new LawStore(':memory:');

test('replaceLaws is wholesale per scope and dedups by normalized statement', () => {
  const s = fresh();
  s.replaceLaws('agent:a1', [
    { scope: 'agent:a1', statement: 'User deploys with Bun, never Node', support: ['f1'], confidence: 0.9 },
    { scope: 'agent:a1', statement: '  user deploys with bun, never node  ', confidence: 0.5 } // dup (normalized)
  ]);
  let laws = s.listLaws(['agent:a1']);
  expect(laws).toHaveLength(1);
  expect(laws[0]?.statement).toBe('User deploys with Bun, never Node');
  expect(laws[0]?.support).toEqual(['f1']);

  // re-derive replaces the scope wholesale (old law gone, new one in)
  s.replaceLaws('agent:a1', [{ scope: 'agent:a1', statement: 'User prefers TypeScript strict mode', confidence: 0.8 }]);
  laws = s.listLaws(['agent:a1']);
  expect(laws).toHaveLength(1);
  expect(laws[0]?.statement).toBe('User prefers TypeScript strict mode');
});

test('confidence is clamped and laws sort by confidence desc', () => {
  const s = fresh();
  s.replaceLaws('global', [
    { scope: 'global', statement: 'low', confidence: 0.2 },
    { scope: 'global', statement: 'high', confidence: 5 }, // clamped to 1
    { scope: 'global', statement: 'mid', confidence: 0.6 }
  ]);
  const laws = s.listLaws(['global']);
  expect(laws.map((l) => l.statement)).toEqual(['high', 'mid', 'low']);
  expect(laws[0]?.confidence).toBe(1);
});

test('listLaws is scope-isolated and unions requested scopes', () => {
  const s = fresh();
  s.replaceLaws('agent:a1', [{ scope: 'agent:a1', statement: 'a1 rule', confidence: 0.7 }]);
  s.replaceLaws('agent:a2', [{ scope: 'agent:a2', statement: 'a2 rule', confidence: 0.7 }]);
  s.replaceLaws('global', [{ scope: 'global', statement: 'global rule', confidence: 0.7 }]);
  expect(s.listLaws(['agent:a1']).map((l) => l.statement)).toEqual(['a1 rule']);
  expect(
    s
      .listLaws(['agent:a1', 'global'])
      .map((l) => l.statement)
      .sort()
  ).toEqual(['a1 rule', 'global rule']);
  expect(s.listLaws([]).length).toBe(0);
});

test('listAll returns every scope ordered by scope then confidence', () => {
  const s = fresh();
  s.replaceLaws('global', [
    { scope: 'global', statement: 'g-low', confidence: 0.2 },
    { scope: 'global', statement: 'g-high', confidence: 0.9 }
  ]);
  s.replaceLaws('agent:a1', [{ scope: 'agent:a1', statement: 'a1 rule', confidence: 0.5 }]);
  const all = s.listAll();
  expect(all.map((l) => l.statement)).toEqual(['a1 rule', 'g-high', 'g-low']); // scope asc, then confidence desc
});

test('setContradictions flags laws and replaceLaws clears the flag', () => {
  const s = fresh();
  s.replaceLaws('agent:a1', [
    { scope: 'agent:a1', statement: 'never Node', confidence: 0.9 },
    { scope: 'agent:a1', statement: 'dark mode', confidence: 0.7 }
  ]);
  const idOf = (statement: string): string => {
    const law = s.listLaws(['agent:a1']).find((l) => l.statement === statement);
    if (!law) throw new Error(`missing law: ${statement}`);
    return law.id;
  };
  const neverNodeId = idOf('never Node');
  const darkModeId = idOf('dark mode');
  expect(s.listLaws(['agent:a1']).find((l) => l.id === neverNodeId)?.contradictedBy).toBeNull();

  s.setContradictions('agent:a1', new Map([[neverNodeId, 'now uses Node']]));
  const flagged = s.listLaws(['agent:a1']);
  expect(flagged.find((l) => l.id === neverNodeId)?.contradictedBy).toBe('now uses Node');
  expect(flagged.find((l) => l.id === darkModeId)?.contradictedBy).toBeNull(); // others untouched

  // a fresh setContradictions clears the prior flag (resolved contradiction)
  s.setContradictions('agent:a1', new Map());
  expect(s.listLaws(['agent:a1']).every((l) => l.contradictedBy === null)).toBe(true);

  // re-deriving the scope also clears flags
  s.setContradictions('agent:a1', new Map([[neverNodeId, 'x']]));
  s.replaceLaws('agent:a1', [{ scope: 'agent:a1', statement: 'never Node', confidence: 0.9 }]);
  expect(s.listLaws(['agent:a1'])[0]?.contradictedBy).toBeNull();
});

test('replacing one scope leaves others intact', () => {
  const s = fresh();
  s.replaceLaws('agent:a1', [{ scope: 'agent:a1', statement: 'keep me', confidence: 0.7 }]);
  s.replaceLaws('global', [{ scope: 'global', statement: 'replace target', confidence: 0.7 }]);
  s.replaceLaws('global', []); // wipe global
  expect(s.listLaws(['global'])).toHaveLength(0);
  expect(s.listLaws(['agent:a1'])).toHaveLength(1); // untouched
});
