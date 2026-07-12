# Daemon ConfigService Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a testable ConfigService that protects the local daemon from filesystem event storms, guarantees the final quiet-state update is applied, and centralizes config/profile/auth load and save operations without migrating existing ConfigBus consumers yet.

**Architecture:** A generic `ReloadCoordinator` implements trailing debounce and one in-flight apply using only dirty/applying/timer state. `ConfigService` owns the accepted `ConfigSnapshot`, reloads the complete latest snapshot at execution time, suppresses unchanged values, and delegates disk I/O to a `ConfigSource`. A home-backed source adapts existing `@monad/home` APIs; watcher wiring remains injectable until the later migration phase.

**Tech Stack:** Bun 1.3, TypeScript, `bun:test`, existing `@monad/home` APIs.

## Global Constraints

- Use Bun only.
- Do not modify existing ConfigBus consumers, settings handlers, `main.ts`, or bootstrap watchers in this phase.
- Do not introduce RxJS, revisions, an event queue, `maxWait`, or a global transaction abstraction.
- Filesystem callbacks only invalidate; they do not read, parse, compare, or apply configuration.
- At most one apply may run at a time.
- A change arriving during apply schedules exactly one trailing follow-up apply.
- Invalid or absent snapshots do not replace the accepted snapshot.
- ConfigService updates its accepted snapshot only after the injected runtime apply succeeds.
- Do not use assertions whose only claim is existence/non-existence unless presence/absence is the domain behavior under test.

---

## File Structure

```text
apps/monad/src/config/
├── reload.ts   # Generic trailing-debounce single-flight coordinator
├── service.ts  # ConfigSnapshot owner and update/watch facade
└── source.ts   # @monad/home-backed load/save adapter

apps/monad/test/unit/config/
├── reload.test.ts
├── service.test.ts
└── source.test.ts
```

---

### Task 1: Trailing single-flight ReloadCoordinator

**Files:**
- Create: `apps/monad/src/config/reload.ts`
- Test: `apps/monad/test/unit/config/reload.test.ts`

**Interfaces:**
- Produces: `ReloadCoordinator`, `ReloadScheduler`, `ReloadCoordinatorOptions`.
- Consumes: an async `apply` callback and injected timer functions.

- [ ] **Step 1: Write failing coordinator tests**

Use this deterministic scheduler instead of real time:

```ts
function manualScheduler() {
  let nextId = 0;
  const pending = new Map<number, () => void>();
  return {
    scheduler: {
      set: (callback: () => void) => {
        const id = ++nextId;
        pending.set(id, callback);
        return id;
      },
      clear: (id: unknown) => pending.delete(id as number)
    },
    runNext: () => {
      const entry = pending.entries().next().value as [number, () => void] | undefined;
      if (!entry) throw new Error('no scheduled reload');
      pending.delete(entry[0]);
      entry[1]();
    },
    pendingCount: () => pending.size
  };
}
```

Add tests that assert:

```ts
test('collapses an event burst into one trailing apply', async () => {
  const clock = manualScheduler();
  let applies = 0;
  const coordinator = new ReloadCoordinator({ apply: async () => void applies++, scheduler: clock.scheduler });
  coordinator.request();
  coordinator.request();
  coordinator.request();
  expect(clock.pendingCount()).toBe(1);
  clock.runNext();
  await coordinator.whenIdle();
  expect(applies).toBe(1);
});

test('runs one trailing follow-up when invalidated during apply', async () => {
  const clock = manualScheduler();
  const releases: Array<() => void> = [];
  let active = 0;
  let maxActive = 0;
  let applies = 0;
  const coordinator = new ReloadCoordinator({
    scheduler: clock.scheduler,
    apply: async () => {
      applies++;
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
    }
  });
  coordinator.request();
  clock.runNext();
  await Bun.sleep(0);
  coordinator.request();
  coordinator.request();
  expect(clock.pendingCount()).toBe(0);
  releases.shift()?.();
  await Bun.sleep(0);
  expect(clock.pendingCount()).toBe(1);
  clock.runNext();
  await Bun.sleep(0);
  releases.shift()?.();
  await coordinator.whenIdle();
  expect({ applies, maxActive }).toEqual({ applies: 2, maxActive: 1 });
});

test('stop cancels a trailing timer and waits for an active apply', async () => {
  const clock = manualScheduler();
  let applies = 0;
  const coordinator = new ReloadCoordinator({ apply: async () => void applies++, scheduler: clock.scheduler });
  coordinator.request();
  await coordinator.stop();
  expect({ applies, pending: clock.pendingCount() }).toEqual({ applies: 0, pending: 0 });
});
```

- [ ] **Step 2: Run tests and verify RED**

```bash
bun scripts/bun-test.ts apps/monad/test/unit/config/reload.test.ts --only-failures
```

Expected: FAIL because `#/config/reload.ts` does not exist.

- [ ] **Step 3: Implement ReloadCoordinator**

Create these contracts:

```ts
export interface ReloadScheduler {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface ReloadCoordinatorOptions {
  apply: () => Promise<void>;
  debounceMs?: number;
  onError?: (error: unknown) => void;
  scheduler?: ReloadScheduler;
}

export class ReloadCoordinator {
  request(): void;
  flush(): Promise<void>;
  whenIdle(): Promise<void>;
  stop(): Promise<void>;
}
```

Implementation rules:

- Default scheduler wraps `setTimeout` and `clearTimeout`; default debounce is 150 ms.
- `request()` sets dirty and resets one trailing timer when idle.
- While applying, `request()` only sets dirty.
- Timer callbacks call `flush()` and route rejection to `onError` so no unhandled promise occurs.
- `flush()` cancels the timer, waits for an active apply, and drains dirty state without overlap.
- After an apply settles, dirty state schedules a fresh trailing timer instead of immediately looping; this bounds work during a continuous storm.
- `whenIdle()` waits for the active apply but does not force a scheduled trailing timer.
- `stop()` rejects future requests, cancels the timer, clears dirty state, and waits for the active apply.

- [ ] **Step 4: Run coordinator tests and commit**

Expected: all coordinator tests pass.

```bash
git add apps/monad/src/config/reload.ts apps/monad/test/unit/config/reload.test.ts
git commit -m "feat(config): add single-flight reload coordinator"
```

---

### Task 2: ConfigService snapshot and update facade

**Files:**
- Create: `apps/monad/src/config/service.ts`
- Test: `apps/monad/test/unit/config/service.test.ts`

**Interfaces:**
- Consumes: `ReloadCoordinator` from Task 1; `MonadConfig` and `MonadAuth` from `@monad/home`.
- Produces: `ConfigSnapshot`, `ConfigSource`, `ConfigService`, `ConfigServiceOptions`.

- [ ] **Step 1: Write failing service tests**

Use a fake source whose `load()` returns its current snapshot, `saveConfig()` and `saveAuth()` mutate it, and `watch()` captures one callback. Cover exact behavior:

```ts
test('applies only the latest snapshot after a burst', async () => {
  const clock = manualScheduler();
  const source = fakeSource(snapshot('a'));
  const applied: string[] = [];
  const service = new ConfigService({
    initial: snapshot('a'),
    source,
    scheduler: clock.scheduler,
    apply: async (next) => void applied.push(next.cfg.locale)
  });
  service.refresh();
  source.current = snapshot('b');
  service.refresh();
  source.current = snapshot('c');
  clock.runNext();
  await service.whenIdle();
  expect(applied).toEqual(['c']);
  expect(service.get().cfg.locale).toBe('c');
});

test('skips an unchanged snapshot', async () => {
  const clock = manualScheduler();
  const source = fakeSource(snapshot('a'));
  const applied: string[] = [];
  const service = new ConfigService({
    initial: snapshot('a'),
    source,
    scheduler: clock.scheduler,
    apply: async (next) => void applied.push(next.cfg.locale)
  });
  service.refresh();
  clock.runNext();
  await service.whenIdle();
  expect(applied).toEqual([]);
});

test('retains the accepted snapshot when load or apply fails', async () => {
  const clock = manualScheduler();
  const source = fakeSource(snapshot('a'));
  const errors: string[] = [];
  const service = new ConfigService({
    initial: snapshot('a'),
    source,
    scheduler: clock.scheduler,
    onError: (error) => errors.push((error as Error).message),
    apply: async () => {
      throw new Error('apply failed');
    }
  });
  source.current = snapshot('b');
  service.refresh();
  clock.runNext();
  await service.whenIdle();
  expect({ errors, locale: service.get().cfg.locale }).toEqual({ errors: ['apply failed'], locale: 'a' });
});

test('updateConfig saves then applies the disk snapshot before returning', async () => {
  const source = fakeSource(snapshot('a'));
  const applied: string[] = [];
  const service = new ConfigService({
    initial: snapshot('a'),
    source,
    apply: async (next) => void applied.push(next.cfg.locale)
  });
  const accepted = await service.updateConfig((cfg) => ({ ...cfg, locale: 'b' }));
  expect({ applied, locale: accepted.cfg.locale, saves: source.configSaves }).toEqual({
    applied: ['b'],
    locale: 'b',
    saves: ['b']
  });
});
```

Also test that `startWatching()` routes source events to refresh and `stop()` unsubscribes and waits for the coordinator.

- [ ] **Step 2: Run service tests and verify RED**

```bash
bun scripts/bun-test.ts apps/monad/test/unit/config/service.test.ts --only-failures
```

Expected: FAIL because `ConfigService` does not exist.

- [ ] **Step 3: Implement ConfigService**

Define:

```ts
export interface ConfigSnapshot {
  cfg: MonadConfig;
  auth: MonadAuth | null;
}

export interface ConfigSource {
  load(): Promise<ConfigSnapshot | null>;
  saveConfig(cfg: MonadConfig): Promise<void>;
  saveAuth(auth: MonadAuth): Promise<void>;
  watch?(onChange: () => void): () => void;
}

export class ConfigService {
  get(): ConfigSnapshot;
  refresh(): void;
  whenIdle(): Promise<void>;
  startWatching(): void;
  updateConfig(mutate: (cfg: MonadConfig) => MonadConfig): Promise<ConfigSnapshot>;
  updateAuth(mutate: (auth: MonadAuth | null) => MonadAuth): Promise<ConfigSnapshot>;
  stop(): Promise<void>;
}
```

The coordinator apply callback must call `source.load()` at execution time, skip null/unchanged snapshots, await the injected runtime apply, then replace the accepted snapshot. Use a deterministic structural comparison injected through `equals`, defaulting to JSON equality. `updateConfig()` and `updateAuth()` save through the source, call `refresh()`, then `flush()` so settings writes retain the current wait-until-applied contract without an event queue.

- [ ] **Step 4: Run service tests and commit**

```bash
git add apps/monad/src/config/service.ts apps/monad/test/unit/config/service.test.ts
git commit -m "feat(config): add live config service"
```

---

### Task 3: Home-backed ConfigSource

**Files:**
- Create: `apps/monad/src/config/source.ts`
- Test: `apps/monad/test/unit/config/source.test.ts`

**Interfaces:**
- Consumes: `ConfigSource`, `ConfigSnapshot`, `MonadPaths`, and existing `@monad/home` load/save APIs.
- Produces: `createHomeConfigSource(paths, watch?)`.

- [ ] **Step 1: Write failing adapter tests**

Inject home I/O functions so tests use temporary paths without mocking modules. Verify exact calls and combined output:

```ts
test('loads config and auth as one snapshot', async () => {
  const source = createHomeConfigSource(paths, {
    loadConfig: async () => cfg,
    loadAuth: async () => auth,
    saveConfig: async () => {},
    saveAuth: async () => {}
  });
  expect(await source.load()).toEqual({ cfg, auth });
});

test('returns null when the config input is unavailable', async () => {
  const source = createHomeConfigSource(paths, {
    loadConfig: async () => null,
    loadAuth: async () => auth,
    saveConfig: async () => {},
    saveAuth: async () => {}
  });
  expect(await source.load()).toBeNull();
});

test('delegates profile and auth writes to their canonical home paths', async () => {
  const writes: string[] = [];
  const source = createHomeConfigSource(paths, {
    loadConfig: async () => cfg,
    loadAuth: async () => auth,
    saveConfig: async (path) => void writes.push(`config:${path}`),
    saveAuth: async (path) => void writes.push(`auth:${path}`)
  });
  await source.saveConfig(cfg);
  await source.saveAuth(auth);
  expect(writes).toEqual([`config:${paths.profile}`, `auth:${paths.auth}`]);
});
```

The null assertion is allowed because temporarily absent/mid-write config is an explicit business path.

- [ ] **Step 2: Implement the adapter**

Default I/O maps to:

```ts
loadConfig: () => loadAll(paths.config, paths.profile)
loadAuth: () => loadAuth(paths.auth)
saveConfig: (_path, cfg) => saveProfile(paths.profile, cfg)
saveAuth: (_path, auth) => saveAuth(paths.auth, auth)
```

Run config and auth reads with `Promise.all`. If config is null, return null even when auth loaded. Pass an optional watcher callback through to the returned `ConfigSource.watch` without owning filesystem semantics here.

- [ ] **Step 3: Run all ConfigService tests, lint, and isolated typecheck**

```bash
bun scripts/bun-test.ts apps/monad/test/unit/config/ --only-failures
bunx biome check apps/monad/src/config apps/monad/test/unit/config
```

Run an isolated strict TypeScript check over the three new source files with `--ignoreConfig`, `--allowImportingTsExtensions`, Bun types, and bundler module resolution. The package-wide typecheck remains subject to the approved pre-existing main-branch failures.

- [ ] **Step 4: Commit and verify scope**

```bash
git add apps/monad/src/config/reload.ts apps/monad/src/config/service.ts apps/monad/src/config/source.ts apps/monad/test/unit/config
git commit -m "feat(config): add home config source"
git diff codex/daemon-runtime-design...HEAD -- apps/monad/src/main.ts apps/monad/src/bootstrap apps/monad/src/services/config-bus.ts
```

Expected final diff command: no output. ConfigService migration is a later plan.
