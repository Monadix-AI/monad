import type { RuntimeModule } from './types.ts';

export interface RuntimeGraph<Snapshot = unknown> {
  modules: ReadonlyMap<string, RuntimeModule<Snapshot>>;
  layers: RuntimeModule<Snapshot>[][];
  reverseLayers: RuntimeModule<Snapshot>[][];
}

export function buildRuntimeGraph<Snapshot = unknown>(
  input: readonly RuntimeModule<Snapshot>[]
): RuntimeGraph<Snapshot> {
  const modules = new Map<string, RuntimeModule<Snapshot>>();
  for (const module of input) {
    if (modules.has(module.id)) throw new Error(`duplicate runtime module "${module.id}"`);
    modules.set(module.id, module);
  }

  const dependents = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const id of modules.keys()) {
    dependents.set(id, new Set());
    indegree.set(id, 0);
  }

  for (const module of modules.values()) {
    const dependencies = new Set([...(module.requires ?? []), ...(module.after ?? [])]);
    for (const dependency of dependencies) {
      if (!modules.has(dependency)) {
        throw new Error(`runtime module "${module.id}" references missing dependency "${dependency}"`);
      }
      dependents.get(dependency)?.add(module.id);
      indegree.set(module.id, (indegree.get(module.id) ?? 0) + 1);
    }
  }

  const layers: RuntimeModule<Snapshot>[][] = [];
  let ready = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
    .sort();
  let consumed = 0;

  while (ready.length > 0) {
    const layerIds = ready;
    ready = [];
    layers.push(layerIds.map((id) => modules.get(id) as RuntimeModule<Snapshot>));
    consumed += layerIds.length;

    for (const id of layerIds) {
      for (const dependent of dependents.get(id) ?? []) {
        const next = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, next);
        if (next === 0) ready.push(dependent);
      }
    }
    ready.sort();
  }

  if (consumed !== modules.size) {
    const remaining = [...indegree.entries()]
      .filter(([, degree]) => degree > 0)
      .map(([id]) => id)
      .sort();
    throw new Error(`runtime dependency cycle: ${remaining.join(', ')}`);
  }

  return { modules, layers, reverseLayers: [...layers].reverse() };
}
