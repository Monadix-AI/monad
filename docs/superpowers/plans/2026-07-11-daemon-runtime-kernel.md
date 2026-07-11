# Daemon Runtime Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tested, standalone RuntimeKernel that validates daemon module dependencies, starts independent modules concurrently, records lifecycle state, reloads modules safely, and shuts them down in reverse dependency order without changing `startDaemon()` yet.

**Architecture:** Lifecycle mechanism lives under `apps/monad/src/runtime/`; domain adapters remain outside this first phase. `RuntimeKernel` owns module outputs in `RuntimeContext`, while a vanilla Zustand store exposes only serializable lifecycle state. The kernel operates on deterministic topological layers and uses `Promise.allSettled()` within each layer.

**Tech Stack:** Bun 1.3, TypeScript, `bun:test`, Zustand 5 vanilla store.

## Global Constraints

- Use Bun only; do not introduce Node-only runtime APIs.
- Do not modify or route `startDaemon()` through the new kernel in this phase.
- Do not create `runtime/modules/`, `runtime/subsystems/`, or a dependency-injection container.
- Keep runtime service instances out of Zustand state.
- Use TDD for every task and run focused tests through `scripts/bun-test.ts --only-failures`.
- Required startup failure rolls back already-started modules in reverse topological order.
- Optional startup failure degrades the runtime; hard dependents become blocked.
- Reload failures retain the previous healthy output.
- Do not add RxJS, revision tracking, an event queue, or new environment variables.

---

## File Structure

```text
apps/monad/src/runtime/
├── types.ts      # Runtime module, health, state, and report contracts
├── graph.ts      # Dependency validation and deterministic topological layers
├── context.ts    # Typed module-output registry owned by RuntimeKernel
├── state.ts      # Vanilla Zustand lifecycle state store
└── kernel.ts     # Start, reload, rollback, and stop orchestration

apps/monad/test/unit/runtime/
├── graph.test.ts
├── context.test.ts
├── state.test.ts
└── kernel.test.ts
```

`apps/monad/src/main.ts` and existing bootstrap files are deliberately untouched.

---

### Task 1: Runtime contracts and dependency graph

**Files:**
- Create: `apps/monad/src/runtime/types.ts`
- Create: `apps/monad/src/runtime/graph.ts`
- Test: `apps/monad/test/unit/runtime/graph.test.ts`

**Interfaces:**
- Produces: `RuntimeModule`, `RuntimeContextReader`, `RuntimeModuleState`, `RuntimeState`, `RuntimeReloadReport`, `RuntimeGraph`, and `buildRuntimeGraph()`.
- Consumes: no new application code.

- [ ] **Step 1: Write failing graph tests**

Create `apps/monad/test/unit/runtime/graph.test.ts` with modules built by this helper:

```ts
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
  expect(() =>
    buildRuntimeGraph([mod('a', { requires: ['b'] }), mod('b', { after: ['a'] })])
  ).toThrow('runtime dependency cycle: a, b');
});
```

- [ ] **Step 2: Run graph tests and verify they fail**

Run:

```bash
bun scripts/bun-test.ts apps/monad/test/unit/runtime/graph.test.ts --only-failures
```

Expected: FAIL because `#/runtime/types.ts` and `#/runtime/graph.ts` do not exist.

- [ ] **Step 3: Add the contracts**

Create `apps/monad/src/runtime/types.ts` with these public contracts:

```ts
export type ModuleId = string;
export type ModuleCriticality = 'required' | 'optional';
export type RuntimePhase = 'booting' | 'ready' | 'degraded' | 'reloading' | 'stopping' | 'failed';
export type ModuleStatus =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'reloading'
  | 'degraded'
  | 'blocked'
  | 'failed'
  | 'stopped';

export interface RuntimeContextReader {
  get<T>(id: ModuleId): T;
  optional<T>(id: ModuleId): T | undefined;
}

export interface ModuleHealth {
  status: 'ready' | 'degraded';
  message?: string;
}

export interface RuntimeModule<Snapshot = unknown> {
  id: ModuleId;
  requires?: readonly ModuleId[];
  after?: readonly ModuleId[];
  criticality: ModuleCriticality;
  start(ctx: RuntimeContextReader, signal: AbortSignal): Promise<unknown>;
  reload?(
    current: unknown,
    snapshot: Snapshot,
    ctx: RuntimeContextReader,
    signal: AbortSignal
  ): Promise<unknown>;
  stop?(current: unknown, ctx: RuntimeContextReader): void | Promise<void>;
  health?(current: unknown): Promise<ModuleHealth>;
}

export interface SerializedRuntimeError {
  name: string;
  message: string;
}

export interface RuntimeModuleState {
  criticality: ModuleCriticality;
  status: ModuleStatus;
  generation: number;
  startedAt?: string;
  lastReloadAt?: string;
  durationMs?: number;
  error?: SerializedRuntimeError;
}

export interface RuntimeState {
  phase: RuntimePhase;
  modules: Record<ModuleId, RuntimeModuleState>;
}

export interface RuntimeReloadReport {
  reloaded: ModuleId[];
  degraded: ModuleId[];
}
```

- [ ] **Step 4: Implement deterministic graph construction**

Create `apps/monad/src/runtime/graph.ts`. Build a map, reject duplicate/missing edges, then run Kahn's algorithm. Sort module IDs before forming each layer so tests and diagnostics are deterministic. Export:

```ts
import type { RuntimeModule } from './types.ts';

export interface RuntimeGraph<Snapshot = unknown> {
  modules: ReadonlyMap<string, RuntimeModule<Snapshot>>;
  layers: RuntimeModule<Snapshot>[][];
  reverseLayers: RuntimeModule<Snapshot>[][];
}

export function buildRuntimeGraph<Snapshot = unknown>(
  input: readonly RuntimeModule<Snapshot>[]
): RuntimeGraph<Snapshot>;
```

Treat both `requires` and `after` as ordering edges. Deduplicate repeated edges so an ID appearing in both arrays increases indegree only once. When Kahn's algorithm cannot consume every module, throw `runtime dependency cycle: ${remainingIds.join(', ')}` with sorted remaining IDs.

- [ ] **Step 5: Run graph tests**

Run the focused command from Step 2.

Expected: 4 pass, 0 fail.

- [ ] **Step 6: Commit Task 1**

```bash
git add apps/monad/src/runtime/types.ts apps/monad/src/runtime/graph.ts apps/monad/test/unit/runtime/graph.test.ts
git commit -m "feat(runtime): add lifecycle dependency graph"
```

---

### Task 2: Runtime output context

**Files:**
- Create: `apps/monad/src/runtime/context.ts`
- Test: `apps/monad/test/unit/runtime/context.test.ts`

**Interfaces:**
- Consumes: `ModuleId` and `RuntimeContextReader` from Task 1.
- Produces: `RuntimeContext` with public read methods and kernel-only mutation methods.

- [ ] **Step 1: Write failing context tests**

```ts
import { expect, test } from 'bun:test';

import { RuntimeContext } from '#/runtime/context.ts';

test('reads committed module outputs', () => {
  const ctx = new RuntimeContext();
  ctx.commit('store', { name: 'db' });

  expect(ctx.get<{ name: string }>('store').name).toBe('db');
  expect(ctx.optional('missing')).toBeUndefined();
});

test('throws a precise error for a missing required output', () => {
  const ctx = new RuntimeContext();
  expect(() => ctx.get('model')).toThrow('runtime output "model" is unavailable');
});

test('replace returns the previous output and remove clears it', () => {
  const ctx = new RuntimeContext();
  ctx.commit('mcp', 'old');
  expect(ctx.replace('mcp', 'new')).toBe('old');
  expect(ctx.remove('mcp')).toBe('new');
  expect(ctx.optional('mcp')).toBeUndefined();
});
```

- [ ] **Step 2: Run context tests and verify they fail**

```bash
bun scripts/bun-test.ts apps/monad/test/unit/runtime/context.test.ts --only-failures
```

Expected: FAIL because `RuntimeContext` does not exist.

- [ ] **Step 3: Implement RuntimeContext**

Create `apps/monad/src/runtime/context.ts`:

```ts
import type { ModuleId, RuntimeContextReader } from './types.ts';

export class RuntimeContext implements RuntimeContextReader {
  private readonly outputs = new Map<ModuleId, unknown>();

  get<T>(id: ModuleId): T {
    if (!this.outputs.has(id)) throw new Error(`runtime output "${id}" is unavailable`);
    return this.outputs.get(id) as T;
  }

  optional<T>(id: ModuleId): T | undefined {
    return this.outputs.get(id) as T | undefined;
  }

  commit(id: ModuleId, output: unknown): void {
    if (this.outputs.has(id)) throw new Error(`runtime output "${id}" is already committed`);
    this.outputs.set(id, output);
  }

  replace(id: ModuleId, output: unknown): unknown {
    const previous = this.get(id);
    this.outputs.set(id, output);
    return previous;
  }

  remove(id: ModuleId): unknown | undefined {
    const previous = this.outputs.get(id);
    this.outputs.delete(id);
    return previous;
  }
}
```

- [ ] **Step 4: Run context tests**

Expected: 3 pass, 0 fail.

- [ ] **Step 5: Commit Task 2**

```bash
git add apps/monad/src/runtime/context.ts apps/monad/test/unit/runtime/context.test.ts
git commit -m "feat(runtime): add module output context"
```

---

### Task 3: Observable lifecycle state

**Files:**
- Modify: `apps/monad/package.json`
- Modify: `bun.lock`
- Create: `apps/monad/src/runtime/state.ts`
- Test: `apps/monad/test/unit/runtime/state.test.ts`

**Interfaces:**
- Consumes: runtime state contracts from Task 1.
- Produces: `RuntimeStateStore` and `createRuntimeStateStore()`.

- [ ] **Step 1: Add Zustand as a direct daemon dependency**

Run from `apps/monad`:

```bash
bun add zustand@^5.0.14
```

Expected: `apps/monad/package.json` contains `"zustand": "^5.0.14"` and `bun.lock` updates.

- [ ] **Step 2: Write failing state-store tests**

```ts
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
```

- [ ] **Step 3: Run state tests and verify they fail**

```bash
bun scripts/bun-test.ts apps/monad/test/unit/runtime/state.test.ts --only-failures
```

Expected: FAIL because `createRuntimeStateStore()` does not exist.

- [ ] **Step 4: Implement the vanilla store**

Create `apps/monad/src/runtime/state.ts`:

```ts
import type { StoreApi } from 'zustand/vanilla';
import type { RuntimeModule, RuntimeState } from './types.ts';

import { createStore } from 'zustand/vanilla';

export type RuntimeStateStore = StoreApi<RuntimeState>;

export function createRuntimeStateStore(modules: readonly RuntimeModule[]): RuntimeStateStore {
  const entries = [...modules]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((module) => [
      module.id,
      { criticality: module.criticality, generation: 0, status: 'idle' as const }
    ]);
  return createStore<RuntimeState>()(() => ({ phase: 'booting', modules: Object.fromEntries(entries) }));
}
```

- [ ] **Step 5: Run state tests and package typecheck**

```bash
bun scripts/bun-test.ts apps/monad/test/unit/runtime/state.test.ts --only-failures
bun run --cwd apps/monad typecheck
```

Expected: 2 tests pass and typecheck exits 0.

- [ ] **Step 6: Commit Task 3**

```bash
git add apps/monad/package.json bun.lock apps/monad/src/runtime/state.ts apps/monad/test/unit/runtime/state.test.ts
git commit -m "feat(runtime): add lifecycle state store"
```

---

### Task 4: RuntimeKernel start, reload, rollback, and stop

**Files:**
- Create: `apps/monad/src/runtime/kernel.ts`
- Test: `apps/monad/test/unit/runtime/kernel.test.ts`

**Interfaces:**
- Consumes: `buildRuntimeGraph()`, `RuntimeContext`, `createRuntimeStateStore()`, and Task 1 contracts.
- Produces: `RuntimeKernel<Snapshot>` with `start()`, `reload(snapshot)`, `stop()`, `context`, and `state`.

- [ ] **Step 1: Write failing start/concurrency tests**

Create helpers in `kernel.test.ts` for deferred promises and event recording, then add:

```ts
test('starts one topological layer concurrently and waits before dependents', async () => {
  const events: string[] = [];
  let releaseStore!: () => void;
  let releaseModel!: () => void;
  const storeReady = new Promise<void>((resolve) => (releaseStore = resolve));
  const modelReady = new Promise<void>((resolve) => (releaseModel = resolve));

  const kernel = new RuntimeKernel([
    module('store', async () => {
      events.push('store:start');
      await storeReady;
      events.push('store:done');
      return 'store';
    }),
    module('model', async () => {
      events.push('model:start');
      await modelReady;
      events.push('model:done');
      return 'model';
    }),
    module('agent', async () => {
      events.push('agent:start');
      return 'agent';
    }, { requires: ['store', 'model'] })
  ]);

  const starting = kernel.start();
  await Bun.sleep(0);
  expect(events).toEqual(['model:start', 'store:start']);
  expect(events).not.toContain('agent:start');
  releaseStore();
  releaseModel();
  await starting;
  expect(events.at(-1)).toBe('agent:start');
  expect(kernel.state.getState().phase).toBe('ready');
});
```

The local `module()` helper must accept `id`, `start`, and optional `requires`, `after`, `criticality`, `reload`, and `stop` fields and return a `RuntimeModule`.

- [ ] **Step 2: Add failing required rollback and optional degradation tests**

Cover these exact outcomes:

```ts
test('required failure aborts startup and rolls back reverse layers', async () => {
  const stopped: string[] = [];
  const kernel = new RuntimeKernel([
    module('store', async () => 'store', { stop: () => void stopped.push('store') }),
    module('model', async () => 'model', { stop: () => void stopped.push('model') }),
    module('agent', async () => {
      throw new Error('bad agent');
    }, { requires: ['store', 'model'] })
  ]);

  await expect(kernel.start()).rejects.toThrow('required runtime module "agent" failed: bad agent');
  expect(stopped.sort()).toEqual(['model', 'store']);
  expect(kernel.state.getState().phase).toBe('failed');
});

test('optional failure degrades runtime and blocks its hard dependent', async () => {
  const kernel = new RuntimeKernel([
    module('store', async () => 'store'),
    module('mcp', async () => {
      throw new Error('offline');
    }, { criticality: 'optional' }),
    module('mcp-index', async () => 'index', { criticality: 'optional', requires: ['mcp'] })
  ]);

  await kernel.start();
  expect(kernel.state.getState().phase).toBe('degraded');
  expect(kernel.state.getState().modules.mcp?.status).toBe('degraded');
  expect(kernel.state.getState().modules['mcp-index']?.status).toBe('blocked');
});
```

- [ ] **Step 3: Add failing reload and shutdown tests**

Verify that reload methods in one layer run concurrently, layers remain ordered, successful output replacement increments generation, a failed reload keeps the previous output, and stop runs reverse layers:

```ts
test('reload keeps the previous output when an optional module fails', async () => {
  const kernel = new RuntimeKernel<{ fail: boolean }>([
    module('mcp', async () => 'old', {
      criticality: 'optional',
      reload: async (_current, snapshot) => {
        if (snapshot.fail) throw new Error('reconnect failed');
        return 'new';
      }
    })
  ]);
  await kernel.start();
  const report = await kernel.reload({ fail: true });
  expect(report).toEqual({ degraded: ['mcp'], reloaded: [] });
  expect(kernel.context.get('mcp')).toBe('old');
});

test('stops dependents before dependencies', async () => {
  const stopped: string[] = [];
  const kernel = new RuntimeKernel([
    module('store', async () => 'store', { stop: () => void stopped.push('store') }),
    module('agent', async () => 'agent', {
      requires: ['store'],
      stop: () => void stopped.push('agent')
    })
  ]);
  await kernel.start();
  await kernel.stop();
  expect(stopped).toEqual(['agent', 'store']);
  expect(kernel.state.getState().modules.agent?.status).toBe('stopped');
});
```

- [ ] **Step 4: Run kernel tests and verify they fail**

```bash
bun scripts/bun-test.ts apps/monad/test/unit/runtime/kernel.test.ts --only-failures
```

Expected: FAIL because `RuntimeKernel` does not exist.

- [ ] **Step 5: Implement RuntimeKernel start and rollback**

Create `apps/monad/src/runtime/kernel.ts` with:

```ts
export class RuntimeKernel<Snapshot = unknown> {
  readonly context = new RuntimeContext();
  readonly state: RuntimeStateStore;

  constructor(modules: readonly RuntimeModule<Snapshot>[]) {
    this.graph = buildRuntimeGraph(modules);
    this.state = createRuntimeStateStore(modules);
  }

  async start(): Promise<void>;
  async reload(snapshot: Snapshot): Promise<RuntimeReloadReport>;
  async stop(): Promise<void>;
}
```

Implementation requirements:

- Before each start, set status `starting` and `startedAt`.
- Skip a module whose hard dependency has no output; mark optional modules blocked and treat a required blocked module as startup failure.
- Run eligible modules in a layer through `Promise.allSettled()`.
- Commit successful outputs only after their own start resolves.
- Set generation to 1 on first successful start and record duration.
- Serialize errors as `{ name, message }` without stacks.
- On required failure, abort the shared controller, stop committed outputs through reverse layers, set phase failed, and throw the exact required-module error used by tests.
- On optional failure, mark degraded and continue.
- After startup, set phase degraded if any module is degraded or blocked; otherwise ready.

- [ ] **Step 6: Implement reload and stop**

Reload requirements:

- Set phase reloading while work runs.
- Traverse forward layers and run only modules with `reload` and a current output.
- Run reloads concurrently within a layer.
- Replace context output only after a reload promise resolves.
- Increment generation and set `lastReloadAt` after success.
- Retain old output and mark degraded after failure.
- Return sorted `reloaded` and `degraded` arrays.
- Finish ready when no module is degraded/blocked, otherwise degraded.

Stop requirements:

- Set phase stopping.
- Traverse reverse layers.
- Run stops concurrently within a reverse layer and continue after individual stop errors.
- Remove each output after its stop settles and mark it stopped.
- Preserve a serialized stop error on a failed module while continuing cleanup.

- [ ] **Step 7: Run all RuntimeKernel tests**

```bash
bun scripts/bun-test.ts apps/monad/test/unit/runtime/ --only-failures
```

Expected: all runtime unit tests pass.

- [ ] **Step 8: Run daemon typecheck and focused lint**

```bash
bun run --cwd apps/monad typecheck
bunx biome check apps/monad/src/runtime apps/monad/test/unit/runtime apps/monad/package.json
```

Expected: both commands exit 0.

- [ ] **Step 9: Commit Task 4**

```bash
git add apps/monad/src/runtime/kernel.ts apps/monad/test/unit/runtime/kernel.test.ts
git commit -m "feat(runtime): orchestrate module lifecycle"
```

---

## Phase Completion Verification

- [ ] Run the full daemon unit suite:

```bash
bun scripts/bun-test.ts apps/monad/test/unit/ --only-failures
```

Expected: all daemon unit tests pass. If the clean worktree is still missing generated artifacts, run the repository generation scripts first and report that setup issue separately from RuntimeKernel failures.

- [ ] Confirm `apps/monad/src/main.ts` and existing bootstrap files are unchanged:

```bash
git diff codex/daemon-runtime-design...HEAD -- apps/monad/src/main.ts apps/monad/src/bootstrap
```

Expected: no output.

- [ ] Review `git diff --check` and the branch log, then proceed to the separate ConfigService implementation plan.
