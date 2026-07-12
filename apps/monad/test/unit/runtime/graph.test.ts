import type { RuntimeModule } from '#/runtime/types.ts';

import { expect, test } from 'bun:test';

import { buildRuntimeGraph } from '#/runtime/graph.ts';

function mod(id: string, deps: { after?: string[]; requires?: string[] } = {}): RuntimeModule {
  return {
    id,
    criticality: 'required',
    ...deps,
    start: async () => id
  };
}

test('builds deterministic topological layers', () => {
  const graph = buildRuntimeGraph([
    mod('handlers', { requires: ['agent'] }),
    mod('store'),
    mod('agent', { requires: ['store', 'model'] }),
    mod('model'),
    mod('metrics', { after: ['store'] })
  ]);

  expect(graph.layers.map((layer) => layer.map((m) => m.id))).toEqual([
    ['model', 'store'],
    ['agent', 'metrics'],
    ['handlers']
  ]);
  expect(graph.reverseLayers.map((layer) => layer.map((m) => m.id))).toEqual([
    ['handlers'],
    ['agent', 'metrics'],
    ['model', 'store']
  ]);
});

test('rejects duplicate module ids', () => {
  expect(() => buildRuntimeGraph([mod('store'), mod('store')])).toThrow('duplicate runtime module "store"');
});

test('rejects missing required and ordering dependencies', () => {
  expect(() => buildRuntimeGraph([mod('agent', { requires: ['store'] })])).toThrow(
    'runtime module "agent" references missing dependency "store"'
  );
  expect(() => buildRuntimeGraph([mod('metrics', { after: ['store'] })])).toThrow(
    'runtime module "metrics" references missing dependency "store"'
  );
});

test('rejects dependency cycles with the involved ids', () => {
  expect(() => buildRuntimeGraph([mod('a', { requires: ['b'] }), mod('b', { after: ['a'] })])).toThrow(
    'runtime dependency cycle: a, b'
  );
});
