# Daemon Runtime Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the thin daemon runtime composition seam that connects `RuntimeKernel` and `ConfigService` with explicit startup, reload, rollback, and shutdown ordering.

**Architecture:** `runtime/create.ts` constructs one typed `RuntimeKernel<ConfigSnapshot>` and one sibling `ConfigService`. Runtime startup completes the kernel before enabling file watching; accepted config snapshots reload the kernel; shutdown disables config invalidation before stopping modules. Existing `main.ts`, bootstrap helpers, `ReloadService`, and `ConfigBus` remain untouched until domain lifecycle descriptors are ready.

**Tech Stack:** Bun 1.3, TypeScript, Zustand vanilla through the existing RuntimeKernel state store, `bun:test`.

## Global Constraints

- Use Bun only.
- Follow test-driven development: observe the focused test fail before creating production code.
- Do not migrate `main.ts`, bootstrap helpers, `ReloadService`, or `ConfigBus` in this phase.
- Do not add a dependency-injection container, RxJS, revisions, an event queue, or `maxWait`.
- Runtime objects remain in `RuntimeKernel` and `RuntimeContext`; Zustand stores serializable lifecycle state only.
- File watching starts only after every runtime module reaches a terminal startup state.
- If watcher startup fails, stop the already-started kernel before propagating the error.
- Stop config watching before stopping runtime modules.
- Do not use assertions whose only claim is existence or non-existence unless presence or absence is explicit domain behavior.

---

## File Structure

```text
apps/monad/src/runtime/
└── create.ts

apps/monad/test/unit/runtime/
└── create.test.ts
```

### Task 1: Runtime composition seam

**Files:**
- Create: `apps/monad/src/runtime/create.ts`
- Test: `apps/monad/test/unit/runtime/create.test.ts`

**Interfaces:**
- Consumes: `RuntimeKernel<ConfigSnapshot>`, `RuntimeModule<ConfigSnapshot>`, `ConfigService`, `ConfigSource`, `ConfigSnapshot`, and optional `ReloadScheduler`.
- Produces: `createDaemonRuntime(options): DaemonRuntime`, `DaemonRuntimeOptions`, and `DaemonRuntime`.

- [ ] **Step 1: Write the failing composition tests**

Create tests with a recording runtime module and in-memory config source. Cover these exact contracts:

```ts
test('starts modules before enabling config watching', async () => {
  const events: string[] = [];
  const runtime = createDaemonRuntime({
    initial: snapshot('a'),
    modules: [recordingModule(events)],
    source: source(snapshot('a'), events)
  });

  await runtime.start();

  expect(events).toEqual(['module:start:a', 'config:watch']);
  await runtime.stop();
});

test('routes the latest accepted config snapshot through kernel reload', async () => {
  const events: string[] = [];
  const clock = manualScheduler();
  const configSource = source(snapshot('a'), events);
  const runtime = createDaemonRuntime({
    initial: snapshot('a'),
    modules: [recordingModule(events)],
    scheduler: clock.scheduler,
    source: configSource
  });
  await runtime.start();
  configSource.current = snapshot('b');
  configSource.emit();
  clock.runNext();
  await runtime.config.whenIdle();

  expect(events).toEqual(['module:start:a', 'config:watch', 'module:reload:b']);
  expect(runtime.config.get().cfg.locale).toBe('b');
  await runtime.stop();
});

test('stops watching before stopping modules', async () => {
  const events: string[] = [];
  const runtime = createDaemonRuntime({
    initial: snapshot('a'),
    modules: [recordingModule(events)],
    source: source(snapshot('a'), events)
  });
  await runtime.start();
  await runtime.stop();

  expect(events).toEqual(['module:start:a', 'config:watch', 'config:unwatch', 'module:stop']);
});

test('rolls back modules when watcher startup fails', async () => {
  const events: string[] = [];
  const runtime = createDaemonRuntime({
    initial: snapshot('a'),
    modules: [recordingModule(events)],
    source: sourceWithFailingWatch(snapshot('a'))
  });

  await expect(runtime.start()).rejects.toThrow('watch failed');
  expect(events).toEqual(['module:start:a', 'module:stop']);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun scripts/bun-test.ts apps/monad/test/unit/runtime/create.test.ts --only-failures
```

Expected: fail because `#/runtime/create.ts` does not exist.

- [ ] **Step 3: Implement the minimal composition seam**

Create these contracts:

```ts
export interface DaemonRuntimeOptions {
  initial: ConfigSnapshot;
  modules: readonly RuntimeModule<ConfigSnapshot>[];
  source: ConfigSource;
  debounceMs?: number;
  equals?: (a: ConfigSnapshot, b: ConfigSnapshot) => boolean;
  onConfigError?: (error: unknown) => void;
  scheduler?: ReloadScheduler;
}

export interface DaemonRuntime {
  readonly config: ConfigService;
  readonly kernel: RuntimeKernel<ConfigSnapshot>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createDaemonRuntime(options: DaemonRuntimeOptions): DaemonRuntime;
```

Construction and lifecycle rules:

```ts
const kernel = new RuntimeKernel<ConfigSnapshot>(options.modules);
const config = new ConfigService({
  initial: options.initial,
  source: options.source,
  apply: (snapshot) => kernel.reload(snapshot),
  debounceMs: options.debounceMs,
  equals: options.equals,
  onError: options.onConfigError,
  scheduler: options.scheduler
});
```

Use conditional spreads for exact optional properties. `start()` awaits `kernel.start()`, then calls `config.startWatching()`. If watcher setup throws, await `kernel.stop()` and rethrow the original error. `stop()` awaits `config.stop()` and always awaits `kernel.stop()` in `finally`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
bun scripts/bun-test.ts apps/monad/test/unit/runtime/create.test.ts --only-failures
```

Expected: all composition tests pass.

- [ ] **Step 5: Run phase verification**

```bash
bun scripts/bun-test.ts apps/monad/test/unit/runtime apps/monad/test/unit/config --only-failures
bunx biome check apps/monad/src/runtime apps/monad/src/config apps/monad/test/unit/runtime apps/monad/test/unit/config
bunx tsc --ignoreConfig --noEmit --strict --skipLibCheck --allowImportingTsExtensions --target ESNext --module Preserve --moduleResolution Bundler --types bun apps/monad/src/runtime/create.ts apps/monad/src/runtime/kernel.ts apps/monad/src/runtime/graph.ts apps/monad/src/runtime/context.ts apps/monad/src/runtime/state.ts apps/monad/src/runtime/types.ts apps/monad/src/config/reload.ts apps/monad/src/config/service.ts apps/monad/src/config/source.ts
git diff --check
git diff codex/daemon-runtime-design...HEAD -- apps/monad/src/main.ts apps/monad/src/bootstrap apps/monad/src/reload apps/monad/src/services/config-bus.ts
```

Expected: focused tests, Biome, isolated strict type checking, and diff checks pass; the protected legacy paths have no diff.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-07-11-daemon-runtime-composition.md apps/monad/src/runtime/create.ts apps/monad/test/unit/runtime/create.test.ts
git commit -m "feat(runtime): compose config lifecycle"
```
