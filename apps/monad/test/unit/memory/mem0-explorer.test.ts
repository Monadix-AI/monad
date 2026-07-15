// collectMem0Data: assembles entries across scopes, joins embeddings → 2D, counts, status — with
// graceful degradation when mem0 is off or vectors are missing.

import { expect, test } from 'bun:test';

import { collectMem0Data, type Mem0ExplorerDeps } from '#/services/memory/mem0-explorer.ts';

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

const base = (over: Partial<Mem0ExplorerDeps>): Mem0ExplorerDeps => ({
  available: () => true,
  vectorStoreName: () => 'qdrant',
  scopes: () => [
    { scope: 'global', kind: 'global', id: '*' },
    { scope: 'agent:a1', kind: 'agent', id: 'a1' }
  ],
  listEntries: async (kind) =>
    kind === 'global'
      ? [{ id: 'g1', text: 'user prefers bun' }]
      : [
          { id: 'a1m1', text: 'project monad' },
          { id: 'a1m2', text: 'uses qdrant' }
        ],
  qdrantStatus: () => ({ phase: 'ready', error: null }),
  log: silent,
  ...over
});

test('returns unavailable when mem0 is not the active backend', async () => {
  const d = await collectMem0Data(base({ available: () => false }));
  expect(d.available).toBe(false);
  expect(d.qdrant?.phase).toBe('ready'); // status still surfaced
});

test('aggregates entries across scopes with per-scope counts', async () => {
  const d = await collectMem0Data(base({}));
  expect(d.total).toBe(3);
  expect(d.entries.map((e) => e.scope).sort()).toEqual(['agent:a1', 'agent:a1', 'global']);
  expect(d.scopeCounts).toEqual([
    { scope: 'agent:a1', count: 2 },
    { scope: 'global', count: 1 }
  ]);
});

test('joins embeddings → 2D coords; entries without a vector get null coords', async () => {
  const vecs = new Map<string, number[]>([
    ['g1', [1, 0, 0, 0]],
    ['a1m1', [0, 1, 0, 0]]
    // a1m2 has no vector
  ]);
  const d = await collectMem0Data(base({ fetchVectors: async () => vecs }));
  const byId = new Map(d.entries.map((e) => [e.id, e]));
  expect(byId.get('g1')?.x).not.toBeNull();
  expect(byId.get('a1m2')?.x).toBeNull(); // no embedding → no coords
});

test('a failing vector fetch degrades gracefully (entries still returned)', async () => {
  const d = await collectMem0Data(
    base({
      fetchVectors: async () => {
        throw new Error('qdrant down');
      }
    })
  );
  expect(d.total).toBe(3);
  expect(d.entries.every((e) => e.x === null)).toBe(true); // cluster map empty, list intact
});

test('a scope that throws is skipped, not fatal', async () => {
  const d = await collectMem0Data(
    base({
      listEntries: async (kind) => {
        if (kind === 'global') throw new Error('boom');
        return [{ id: 'a1m1', text: 'ok' }];
      }
    })
  );
  expect(d.total).toBe(1);
  expect(d.entries[0]?.id).toBe('a1m1');
});
