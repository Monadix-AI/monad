# Daemon Store Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move persistence startup ownership from `bootstrap/` into `store/lifecycle.ts` and expose it as a required RuntimeKernel module with explicit cleanup.

**Architecture:** `store/lifecycle.ts` becomes the source of truth for constructing KV and SQLite resources. It exports both the transitional `createDataLayer()` API used by `main.ts` and a `createStoreLifecycleModule()` descriptor used by the new runtime composition. `bootstrap/data-layer.ts` becomes a compatibility re-export until `main.ts` migrates, while the returned data-layer handle owns idempotent shutdown of the debug server, Redis client, KV listener, and SQLite store.

**Tech Stack:** Bun 1.3, TypeScript, Bun Redis/SQLite, `bun:test`, existing RuntimeKernel contracts.

## Global Constraints

- Use Bun only.
- Follow test-driven development for the lifecycle descriptor and cleanup contract.
- Keep `main.ts` unchanged in this phase.
- Preserve the existing `createDataLayer({ paths, devMode })` call shape and `kv`/`store` outputs.
- `store/lifecycle.ts` owns persistence startup and shutdown; `runtime/` contains no persistence implementation.
- Cleanup is idempotent and runs in dependency-safe order: debug UI, Redis client, KV listener, SQLite store.
- A required store module startup failure remains fatal and is handled by RuntimeKernel rollback.
- Do not add a DI container, environment variable, RxJS, revision, or queue.
- Do not use assertions whose only claim is existence or non-existence unless presence or absence is explicit domain behavior.

---

## File Structure

```text
apps/monad/src/store/
└── lifecycle.ts

apps/monad/src/bootstrap/
└── data-layer.ts

apps/monad/test/unit/store/
└── lifecycle.test.ts
```

### Task 1: Store lifecycle descriptor and owned cleanup

**Files:**
- Create: `apps/monad/src/store/lifecycle.ts`
- Replace: `apps/monad/src/bootstrap/data-layer.ts`
- Test: `apps/monad/test/unit/store/lifecycle.test.ts`

**Interfaces:**
- Consumes: `MonadPaths`, `KvService`, `Store`, `RuntimeModule<ConfigSnapshot>`, existing KV and SQLite constructors.
- Produces: `DataLayer`, `DataLayerOptions`, `createDataLayer()`, `createStoreLifecycleModule()`, and temporary compatibility exports from `bootstrap/data-layer.ts`.

- [ ] **Step 1: Write failing lifecycle tests**

Use an injected `start` function so tests exercise descriptor behavior without opening sockets or SQLite files:

```ts
test('starts the required store module with canonical options', async () => {
  const calls: Array<{ devMode: boolean; home: string }> = [];
  const layer = fakeLayer();
  const module = createStoreLifecycleModule(
    { paths, devMode: true },
    async (options) => {
      calls.push({ devMode: options.devMode, home: options.paths.home });
      return layer;
    }
  );

  const output = await module.start(context, new AbortController().signal);

  expect({ calls, criticality: module.criticality, id: module.id, output }).toEqual({
    calls: [{ devMode: true, home: paths.home }],
    criticality: 'required',
    id: 'store',
    output: layer
  });
});

test('stops the owned data layer through the module lifecycle', async () => {
  const events: string[] = [];
  const layer = fakeLayer(() => void events.push('closed'));
  const module = createStoreLifecycleModule({ paths, devMode: false }, async () => layer);

  await module.stop?.(layer, context);

  expect(events).toEqual(['closed']);
});

test('data layer cleanup is idempotent and dependency ordered', async () => {
  const events: string[] = [];
  const stop = createDataLayerStop({
    stopDebug: () => void events.push('debug'),
    closeClient: () => void events.push('client'),
    stopServer: () => void events.push('server'),
    closeStore: () => void events.push('store')
  });

  await stop();
  await stop();

  expect(events).toEqual(['debug', 'client', 'server', 'store']);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
bun scripts/bun-test.ts apps/monad/test/unit/store/lifecycle.test.ts --only-failures
```

Expected: fail because `#/store/lifecycle.ts` does not exist.

- [ ] **Step 3: Implement the lifecycle source of truth**

Define:

```ts
export interface DataLayerOptions {
  paths: MonadPaths;
  devMode: boolean;
}

export interface DataLayer {
  kv: KvService;
  store: Store;
  stop(): Promise<void>;
}

export type StartDataLayer = (options: DataLayerOptions) => Promise<DataLayer>;

export function createDataLayerStop(resources: {
  stopDebug?: () => void | Promise<void>;
  closeClient: () => void | Promise<void>;
  stopServer: () => void | Promise<void>;
  closeStore: () => void | Promise<void>;
}): () => Promise<void>;

export async function createDataLayer(options: DataLayerOptions): Promise<DataLayer>;

export function createStoreLifecycleModule(
  options: DataLayerOptions,
  start: StartDataLayer = createDataLayer
): RuntimeModule<ConfigSnapshot>;
```

`createDataLayerStop()` uses one closed flag and awaits each cleanup function exactly once in the declared order. `createDataLayer()` retains the current KV probe/fallback, tracing, optional debug UI, orphan repair, and home integrity behavior, but returns the stop function. Register the same idempotent stop function for process exit compatibility. `createStoreLifecycleModule()` returns `{ id: 'store', criticality: 'required', start: () => start(options), stop: (current) => (current as DataLayer).stop() }`.

- [ ] **Step 4: Replace bootstrap implementation with a compatibility re-export**

Use this complete file:

```ts
export {
  createDataLayer,
  type DataLayer,
  type DataLayerOptions
} from '#/store/lifecycle.ts';
```

- [ ] **Step 5: Run focused and phase verification**

```bash
bun scripts/bun-test.ts apps/monad/test/unit/store/lifecycle.test.ts apps/monad/test/unit/runtime apps/monad/test/unit/config --only-failures
bunx biome check apps/monad/src/store/lifecycle.ts apps/monad/src/bootstrap/data-layer.ts apps/monad/test/unit/store/lifecycle.test.ts
bunx tsc --ignoreConfig --noEmit --strict --skipLibCheck --allowImportingTsExtensions --target ESNext --module Preserve --moduleResolution Bundler --types bun apps/monad/src/store/lifecycle.ts apps/monad/src/bootstrap/data-layer.ts apps/monad/src/runtime/types.ts apps/monad/src/config/service.ts
git diff --check
git diff -- apps/monad/src/main.ts
```

Expected: focused tests, Biome, isolated strict type checking, and diff checks pass; `main.ts` has no diff.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-07-11-daemon-store-lifecycle.md apps/monad/src/store/lifecycle.ts apps/monad/src/bootstrap/data-layer.ts apps/monad/test/unit/store/lifecycle.test.ts
git commit -m "feat(store): own daemon data lifecycle"
```
