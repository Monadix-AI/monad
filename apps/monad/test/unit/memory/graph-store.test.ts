// L2 GraphStore (bun:sqlite, in-memory): node dedup, edge merge + validity, FTS search, deletion
// reconciliation by support-liveness, and per-session cursors.

import { expect, test } from 'bun:test';

import { GraphStore } from '@/services/memory/graph/store.ts';

const S = 'agent:a1';
const fresh = () => new GraphStore(':memory:');

test('upsertNode dedups by normalized name within scope', () => {
  const g = fresh();
  const id1 = g.upsertNode({ scope: S, name: 'Zeke' });
  const id2 = g.upsertNode({ scope: S, name: '  zeke ', type: 'person', aliases: ['z'] });
  expect(id2).toBe(id1); // same scope + normalized name → one node
  const node = g.getNode([S], 'ZEKE');
  expect(node?.id).toBe(id1);
  expect(node?.type).toBe('person'); // later upsert filled type
  expect(node?.aliases).toEqual(['z']);
  // a different scope is a different node
  expect(g.upsertNode({ scope: 'global', name: 'Zeke' })).not.toBe(id1);
});

test('upsertEdge merges support + bumps confidence for the same relation, new window for a different one', () => {
  const g = fresh();
  const a = g.upsertNode({ scope: S, name: 'Zeke' });
  const b = g.upsertNode({ scope: S, name: 'Monad' });
  const e1 = g.upsertEdge({
    scope: S,
    src: a,
    dst: b,
    relation: 'works_on',
    provClass: 'machine',
    support: ['m1'],
    confidence: 0.5
  });
  const e1b = g.upsertEdge({
    scope: S,
    src: a,
    dst: b,
    relation: 'works_on',
    provClass: 'machine',
    support: ['m2'],
    confidence: 0.5
  });
  expect(e1b).toBe(e1); // merged into the same current edge
  const edges = g.edgesFor(a);
  expect(edges).toHaveLength(1);
  expect(edges.flatMap((e) => e.support).sort()).toEqual(['m1', 'm2']);
  expect(edges.every((e) => e.confidence > 0.5)).toBe(true); // bumped by new support

  // a different relation is a separate edge
  g.upsertEdge({
    scope: S,
    src: a,
    dst: b,
    relation: 'founded',
    provClass: 'machine',
    support: ['m3'],
    confidence: 0.9
  });
  expect(g.edgesFor(a)).toHaveLength(2);
  // a user edge never merges with a machine edge
  g.upsertEdge({ scope: S, src: a, dst: b, relation: 'works_on', provClass: 'user', support: ['m4'], confidence: 1 });
  expect(g.edgesFor(a)).toHaveLength(3);
});

test('searchNodes does prefix FTS over name + aliases; edgesAmong returns the paths between hits', () => {
  const g = fresh();
  const a = g.upsertNode({ scope: S, name: 'Zeke', aliases: ['the founder'] });
  const b = g.upsertNode({ scope: S, name: 'Monad', aliases: ['the daemon'] });
  g.upsertNode({ scope: S, name: 'unrelated thing' });
  g.upsertEdge({
    scope: S,
    src: a,
    dst: b,
    relation: 'works_on',
    provClass: 'machine',
    support: ['m1'],
    confidence: 0.7
  });

  const both = g.searchNodes([S], 'zeke OR monad'); // tokens prefix-matched
  const among = g.edgesAmong(both.map((n) => n.id));
  expect(among.map((e) => e.relation)).toEqual(['works_on']);
});

test('reconcile prunes dead support and retracts edges with none left', () => {
  const g = fresh();
  const a = g.upsertNode({ scope: S, name: 'A' });
  const b = g.upsertNode({ scope: S, name: 'B' });
  const c = g.upsertNode({ scope: S, name: 'C' });
  g.upsertEdge({
    scope: S,
    src: a,
    dst: b,
    relation: 'r',
    provClass: 'machine',
    support: ['m1', 'm2'],
    confidence: 0.6
  });
  g.upsertEdge({ scope: S, src: a, dst: c, relation: 'r', provClass: 'machine', support: ['m3'], confidence: 0.6 });

  // m2 + m3 deleted (soft-delete / hard-delete both look like "not alive")
  const alive = new Set(['m1']);
  const { prunedEdges } = g.reconcile((id) => alive.has(id));
  expect(prunedEdges).toBe(1); // a→c lost its only support → retracted

  const edges = g.edgesFor(a);
  expect(edges).toHaveLength(1); // only a→b remains current
  expect(edges.flatMap((e) => e.support)).toEqual(['m1']); // dead m2 pruned from support
});

test('per-session cursors: get/set/drop + knownSessions', () => {
  const g = fresh();
  g.setCursor('ses_1', 'msg_10');
  g.setCursor('ses_2', 'msg_20');
  expect(g.getCursor('ses_1')).toBe('msg_10');
  g.setCursor('ses_1', 'msg_15'); // advance
  expect(g.getCursor('ses_1')).toBe('msg_15');
  expect(g.knownSessions().sort()).toEqual(['ses_1', 'ses_2']);
  g.dropCursor('ses_1');
  expect(g.knownSessions()).toEqual(['ses_2']);
});
