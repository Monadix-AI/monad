# Daemon Atoms Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move initial atom discovery into the atoms domain and expose it as a required lifecycle module with explicit dependencies.

**Architecture:** The existing gated built-in/third-party discovery implementation moves to `atoms/lifecycle.ts`. Its descriptor reads stable capability and model facades from RuntimeContext, performs discovery, resolves command pins, and finalizes the sandbox launcher only after launcher atoms register. The old bootstrap path remains a compatibility re-export for unchanged `main.ts`.

**Tech Stack:** Bun 1.3, TypeScript, atom pack host, RuntimeKernel, `bun:test`.

## Global Constraints

- Use Bun only and follow TDD.
- Module ID is `atoms`, required, and requires `capabilities` plus `agent.model`.
- Built-in and third-party atoms continue through the same manifest-gated path.
- Finalize sandbox launchers only after discovery.
- Do not connect MCP, load skills, or start channels here.
- Keep `main.ts` unchanged and do not add presence-only assertions.

---

### Task 1: Atoms lifecycle descriptor and ownership

**Files:**
- Move: `apps/monad/src/bootstrap/main-init/atom-discovery.ts` to `apps/monad/src/atoms/lifecycle.ts`
- Create: compatibility re-export at the old path
- Test: `apps/monad/test/unit/atoms/lifecycle.test.ts`

**Interfaces:**
- Consumes: `CapabilitiesRuntime`, `ModelSubsystem`, initial `ConfigSnapshot`, paths, logger.
- Produces: existing `AtomDiscovery`, `createAtomDiscovery()`, and `createAtomsLifecycleModule()`.

- [ ] **Step 1: Write a failing descriptor test**

Commit fake `CapabilitiesRuntime` and `ModelSubsystem` outputs into `RuntimeContext`. Inject a discovery function that records `cfg`, registry, command registry, and model service, then assert the descriptor returns its exact discovery facade with `{ id: 'atoms', criticality: 'required', requires: ['capabilities', 'agent.model'] }`.

- [ ] **Step 2: Verify RED**

```bash
bun scripts/bun-test.ts apps/monad/test/unit/atoms/lifecycle.test.ts --only-failures
```

Expected: missing `#/atoms/lifecycle.ts`.

- [ ] **Step 3: Move discovery and add the descriptor**

```ts
export interface AtomsLifecycleOptions {
  initial: ConfigSnapshot;
  paths: MonadPaths;
  logger: { warn(message: string): void };
}

export function createAtomsLifecycleModule(
  options: AtomsLifecycleOptions,
  discover: typeof createAtomDiscovery = createAtomDiscovery
): RuntimeModule<ConfigSnapshot>;
```

The start function reads `CapabilitiesRuntime` from `capabilities` and `ModelSubsystem` from `agent.model`, then calls discovery with their stable registries and the initial snapshot config.

- [ ] **Step 4: Preserve compatibility**

Replace the old file with:

```ts
export {
  createAtomDiscovery,
  type AtomDiscovery
} from '#/atoms/lifecycle.ts';
```

- [ ] **Step 5: Verify the phase**

```bash
bun scripts/bun-test.ts apps/monad/test/unit/atoms/lifecycle.test.ts apps/monad/test/unit/capabilities/lifecycle.test.ts apps/monad/test/unit/agent/model-lifecycle.test.ts apps/monad/test/unit/runtime --only-failures
bunx biome check apps/monad/src/atoms/lifecycle.ts apps/monad/src/bootstrap/main-init/atom-discovery.ts apps/monad/test/unit/atoms/lifecycle.test.ts
bun build apps/monad/src/main.ts --target=bun --outdir /private/tmp/monad-main-atoms-lifecycle-build
git diff --check
git diff -- apps/monad/src/main.ts
```

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-07-11-daemon-atoms-lifecycle.md apps/monad/src/atoms/lifecycle.ts apps/monad/src/bootstrap/main-init/atom-discovery.ts apps/monad/test/unit/atoms/lifecycle.test.ts
git commit -m "feat(atoms): add discovery lifecycle"
```
