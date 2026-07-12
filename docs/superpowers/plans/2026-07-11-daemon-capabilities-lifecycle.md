# Daemon Capabilities Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the stable capabilities registry as a required lifecycle module downstream of sandbox setup.

**Architecture:** `capabilities/lifecycle.ts` owns the shared `AtomPackRegistry` tool/capability sink and empty `CommandRegistry`. It registers only first-party static tools at startup, applying sandbox-root and credential protections before registration. Atom packs, MCP, skills, and service-backed tools populate the same stable registry in later lifecycle stages.

**Tech Stack:** Bun 1.3, TypeScript, existing tool and command registries, RuntimeKernel, `bun:test`.

## Global Constraints

- Use Bun only and follow TDD.
- Module ID is `capabilities`, required, and requires `platform.sandbox`.
- Register static first-party tools only; do not discover atoms, connect MCP, or load skills.
- Every static tool passes through sandbox constraints and credential protection before registration.
- Preserve one stable registry object for later hot reload.
- Keep `main.ts` unchanged.
- Do not add presence-only assertions.

---

### Task 1: Capabilities registry lifecycle

**Files:**
- Create: `apps/monad/src/capabilities/lifecycle.ts`
- Test: `apps/monad/test/unit/capabilities/lifecycle.test.ts`

**Interfaces:**
- Consumes: `SandboxSetup`, `MonadPaths`, `builtinTools`, protection wrappers, registry constructors.
- Produces: `CapabilitiesRuntime`, `createCapabilitiesRuntime()`, and `createCapabilitiesLifecycleModule()`.

- [ ] **Step 1: Write failing tests**

Test that `createCapabilitiesRuntime()` applies sandbox roots to filesystem scopes, requires approval for credential-directory inputs, and exposes the protected tool through the stable registry. Test that the descriptor is required, requires `platform.sandbox`, passes its output roots to the injected factory, and returns the same runtime facade.

- [ ] **Step 2: Verify RED**

```bash
bun scripts/bun-test.ts apps/monad/test/unit/capabilities/lifecycle.test.ts --only-failures
```

Expected: missing `#/capabilities/lifecycle.ts`.

- [ ] **Step 3: Implement**

Define `CapabilitiesRuntime` with `registry: AtomPackRegistry` and `commandRegistry: CommandRegistry`. `createCapabilitiesRuntime({ paths, sandboxRoots, tools = builtinTools, log })` constructs both registries and registers each protected tool. `createCapabilitiesLifecycleModule()` reads `SandboxSetup` from `platform.sandbox` and returns the created facade.

- [ ] **Step 4: Verify and commit**

```bash
bun scripts/bun-test.ts apps/monad/test/unit/capabilities/lifecycle.test.ts apps/monad/test/unit/platform/sandbox-lifecycle.test.ts apps/monad/test/unit/runtime --only-failures
bunx biome check apps/monad/src/capabilities/lifecycle.ts apps/monad/test/unit/capabilities/lifecycle.test.ts
bun build apps/monad/src/main.ts --target=bun --outdir /private/tmp/monad-main-capabilities-lifecycle-build
git diff --check
git diff -- apps/monad/src/main.ts
git add docs/superpowers/plans/2026-07-11-daemon-capabilities-lifecycle.md apps/monad/src/capabilities/lifecycle.ts apps/monad/test/unit/capabilities/lifecycle.test.ts
git commit -m "feat(capabilities): add registry lifecycle"
```
