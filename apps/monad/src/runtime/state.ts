import type { StoreApi } from 'zustand/vanilla';
import type { RuntimeModule, RuntimeState } from './types.ts';

import { createStore } from 'zustand/vanilla';

export type RuntimeStateStore = StoreApi<RuntimeState>;

export function createRuntimeStateStore(modules: readonly RuntimeModule[]): RuntimeStateStore {
  const entries = [...modules]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((module) => [module.id, { criticality: module.criticality, generation: 0, status: 'idle' as const }]);
  return createStore<RuntimeState>()(() => ({ phase: 'booting', modules: Object.fromEntries(entries) }));
}
