import type { RuntimeModule } from '#/runtime/types.ts';

import { expect, test } from 'bun:test';

import { createRuntimeStateStore } from '#/runtime/state.ts';

const modules: RuntimeModule[] = [
  { id: 'store', criticality: 'required', start: async () => ({}) },
  { id: 'mcp', criticality: 'optional', start: async () => ({}) }
];

test('creates serializable idle state for every module', () => {
  const store = createRuntimeStateStore(modules);
  expect(store.getState()).toEqual({
    phase: 'booting',
    modules: {
      mcp: { criticality: 'optional', generation: 0, status: 'idle' },
      store: { criticality: 'required', generation: 0, status: 'idle' }
    }
  });
  expect(JSON.parse(JSON.stringify(store.getState()))).toEqual(store.getState());
});

test('supports selector-free vanilla subscriptions', () => {
  const store = createRuntimeStateStore(modules);
  const phases: string[] = [];
  const unsubscribe = store.subscribe((state) => phases.push(state.phase));
  store.setState({ ...store.getState(), phase: 'ready' });
  unsubscribe();
  expect(phases).toEqual(['ready']);
});
