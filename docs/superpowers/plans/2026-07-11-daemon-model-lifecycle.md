# Daemon Model Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move long-lived model service ownership into `agent/model/lifecycle.ts` as a required runtime module without constructing AgentLoop at daemon startup.

**Architecture:** The agent model domain owns `ModelService`, `ModelCatalogService`, `EmbeddingIndexer`, provider discovery, the periodic indexer kick, config reload, and shutdown. The lifecycle descriptor requires the `store` module output and preserves stable service objects across reload. `bootstrap/model.ts` remains only as a temporary compatibility re-export for the unchanged `main.ts` path.

**Tech Stack:** Bun 1.3, TypeScript, existing model gateway/catalog/indexer services, RuntimeKernel, `bun:test`.

## Global Constraints

- Use Bun only and follow test-driven development.
- Do not construct AgentLoop during daemon startup.
- Keep `main.ts` unchanged in this phase.
- Preserve the existing `createModelSubsystem({ cfg, paths, store, useMock, auth })` call shape.
- The lifecycle module ID is `agent.model`, is required, and requires `store`.
- Provider discovery completes before the model lifecycle module reports ready.
- Configuration reload mutates the stable `ModelService`; it does not replace the subsystem facade.
- Shutdown clears the periodic embedding kick and stops catalog refresh exactly once.
- Do not use assertions whose only claim is existence or non-existence unless presence or absence is explicit domain behavior.

---

### Task 1: Model lifecycle ownership

**Files:**
- Create: `apps/monad/src/agent/model/lifecycle.ts`
- Replace: `apps/monad/src/bootstrap/model.ts`
- Test: `apps/monad/test/unit/agent/model-lifecycle.test.ts`

**Interfaces:**
- Consumes: `DataLayer` from `store/lifecycle.ts`, `ConfigSnapshot`, and existing model services.
- Produces: `ModelSubsystem`, `ModelSubsystemOptions`, `createModelSubsystem()`, `createModelSubsystemStop()`, and `createModelLifecycleModule()`.

- [ ] **Step 1: Write failing behavior tests**

Cover these contracts with an injected subsystem factory:

```ts
test('requires store and discovers providers before model readiness', async () => {
  const events: string[] = [];
  const subsystem = fakeSubsystem(events);
  const module = createModelLifecycleModule(options(snapshot('a')), async ({ store }) => {
    events.push(`factory:${store === layer.store}`);
    return subsystem;
  });
  context.commit('store', layer);

  const output = await module.start(context, new AbortController().signal);

  expect({ events, id: module.id, requires: module.requires, output }).toEqual({
    events: ['factory:true', 'providers:discover'],
    id: 'agent.model',
    requires: ['store'],
    output: subsystem
  });
});

test('reloads the stable model service from the complete config snapshot', async () => {
  const events: string[] = [];
  const subsystem = fakeSubsystem(events);
  const module = createModelLifecycleModule(options(snapshot('a')), async () => subsystem);

  const output = await module.reload?.(subsystem, snapshot('b'), context, new AbortController().signal);

  expect({ events, output }).toEqual({ events: ['model:reload:b'], output: subsystem });
});

test('stops the owned model subsystem through lifecycle shutdown', async () => {
  const events: string[] = [];
  const subsystem = fakeSubsystem(events);
  const module = createModelLifecycleModule(options(snapshot('a')), async () => subsystem);

  await module.stop?.(subsystem, context);

  expect(events).toEqual(['subsystem:stop']);
});

test('model subsystem cleanup is idempotent', async () => {
  const events: string[] = [];
  const stop = createModelSubsystemStop({
    clearIndexerInterval: () => void events.push('interval'),
    stopCatalog: () => void events.push('catalog')
  });

  stop();
  stop();

  expect(events).toEqual(['interval', 'catalog']);
});
```

- [ ] **Step 2: Verify RED**

```bash
bun scripts/bun-test.ts apps/monad/test/unit/agent/model-lifecycle.test.ts --only-failures
```

Expected: fail because `#/agent/model/lifecycle.ts` does not exist.

- [ ] **Step 3: Implement model lifecycle**

Move the existing model subsystem construction into `agent/model/lifecycle.ts`. Store the interval returned by `setInterval`, call `.unref()`, and create one idempotent stop function that clears it before stopping the catalog. Register that same stop for process exit compatibility and remove the listener on explicit stop.

Define:

```ts
export interface ModelSubsystem {
  modelService: ModelService;
  modelCatalog: ModelCatalogService;
  embeddingIndexer: EmbeddingIndexer;
  stop(): void;
}

export interface ModelLifecycleOptions {
  initial: ConfigSnapshot;
  paths: MonadPaths;
  useMock: boolean;
}

export function createModelLifecycleModule(
  options: ModelLifecycleOptions,
  start: StartModelSubsystem = createModelSubsystem
): RuntimeModule<ConfigSnapshot>;
```

The module starts with the `Store` from `ctx.get<DataLayer>('store')`, awaits `modelService.discoverProviders(paths.providers)`, logs each returned discovery error, and returns the same subsystem. `reload()` calls `modelService.reload(snapshot.cfg, snapshot.auth)` and returns the current subsystem. `stop()` calls the subsystem stop function.

- [ ] **Step 4: Replace bootstrap implementation with compatibility exports**

```ts
export {
  createModelSubsystem,
  type ModelSubsystem
} from '#/agent/model/lifecycle.ts';
```

- [ ] **Step 5: Verify the phase**

```bash
bun scripts/bun-test.ts apps/monad/test/unit/agent/model-lifecycle.test.ts apps/monad/test/unit/store/lifecycle.test.ts apps/monad/test/unit/runtime apps/monad/test/unit/config --only-failures
bunx biome check apps/monad/src/agent/model/lifecycle.ts apps/monad/src/bootstrap/model.ts apps/monad/test/unit/agent/model-lifecycle.test.ts
bun build apps/monad/src/main.ts --target=bun --outdir /private/tmp/monad-main-model-lifecycle-build
git diff --check
git diff -- apps/monad/src/main.ts
```

Expected: focused tests, formatting, main bundle, and diff checks pass; `main.ts` remains unchanged.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-07-11-daemon-model-lifecycle.md apps/monad/src/agent/model/lifecycle.ts apps/monad/src/bootstrap/model.ts apps/monad/test/unit/agent/model-lifecycle.test.ts
git commit -m "feat(agent): own model lifecycle"
```
