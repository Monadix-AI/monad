# Daemon Sandbox Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move sandbox implementation ownership into `platform/sandbox/` and expose initial sandbox setup as a required runtime module.

**Architecture:** The existing sandbox implementation moves unchanged to `platform/sandbox/service.ts`; `bootstrap/sandbox.ts` becomes a compatibility re-export. A small lifecycle descriptor requires the store output and creates the stable sandbox setup from the initial configuration. Launcher finalization remains a later atoms-stage action because sandbox launchers register through atom discovery.

**Tech Stack:** Bun 1.3, TypeScript, existing `@monad/sandbox` services, RuntimeKernel, `bun:test`.

## Global Constraints

- Use Bun only and follow TDD for the new lifecycle descriptor.
- Keep `main.ts` behavior unchanged.
- Do not finalize the sandbox launcher before atom discovery.
- The lifecycle module is `platform.sandbox`, required, and requires `store`.
- Sandbox configuration remains boot-only in this phase.
- Do not add presence-only tests.

---

### Task 1: Sandbox domain ownership and descriptor

**Files:**
- Move: `apps/monad/src/bootstrap/sandbox.ts` to `apps/monad/src/platform/sandbox/service.ts`
- Create: `apps/monad/src/platform/sandbox/lifecycle.ts`
- Create: `apps/monad/src/bootstrap/sandbox.ts` compatibility exports
- Test: `apps/monad/test/unit/platform/sandbox-lifecycle.test.ts`

**Interfaces:**
- Consumes: `DataLayer`, `ConfigSnapshot`, and `createSandbox()`.
- Produces: `createSandboxLifecycleModule(options, start?)` and `SandboxLifecycleOptions`.

- [ ] **Step 1: Write a failing descriptor test**

Assert that the descriptor has ID `platform.sandbox`, is required, requires `store`, forwards initial config/auth/paths and the store to its injected factory, and returns the exact setup facade.

- [ ] **Step 2: Verify RED**

```bash
bun scripts/bun-test.ts apps/monad/test/unit/platform/sandbox-lifecycle.test.ts --only-failures
```

Expected: missing `#/platform/sandbox/lifecycle.ts`.

- [ ] **Step 3: Implement the descriptor**

```ts
export interface SandboxLifecycleOptions {
  initial: ConfigSnapshot;
  paths: MonadPaths;
}

export function createSandboxLifecycleModule(
  options: SandboxLifecycleOptions,
  start: typeof createSandbox = createSandbox
): RuntimeModule<ConfigSnapshot> {
  return {
    id: 'platform.sandbox',
    criticality: 'required',
    requires: ['store'],
    start: (ctx) => {
      const layer = ctx.get<DataLayer>('store');
      return start(options.initial.cfg, options.paths, layer.store, options.initial.auth ?? undefined);
    }
  };
}
```

- [ ] **Step 4: Move service ownership and preserve compatibility**

Move the existing file without behavior changes. Update its relative `services/session-sandbox.ts` imports for the new depth. Replace the old file with exports for `createSandbox`, `finalizeSandboxLauncher`, and `SandboxSetup`.

- [ ] **Step 5: Verify and commit**

```bash
bun scripts/bun-test.ts apps/monad/test/unit/platform/sandbox-lifecycle.test.ts apps/monad/test/unit/bootstrap/fail-closed.test.ts --only-failures
bunx biome check apps/monad/src/platform/sandbox apps/monad/src/bootstrap/sandbox.ts apps/monad/test/unit/platform/sandbox-lifecycle.test.ts
bun build apps/monad/src/main.ts --target=bun --outdir /private/tmp/monad-main-sandbox-lifecycle-build
git diff --check
git diff -- apps/monad/src/main.ts
git add docs/superpowers/plans/2026-07-11-daemon-sandbox-lifecycle.md apps/monad/src/platform/sandbox apps/monad/src/bootstrap/sandbox.ts apps/monad/test/unit/platform/sandbox-lifecycle.test.ts
git commit -m "feat(platform): own sandbox lifecycle"
```
