# Daemon Main Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `apps/monad/src/main.ts` to the daemon entrypoint while lifecycle-owned modules assemble application services, handlers, channels, transports, reload, and cleanup.

**Architecture:** Keep `RuntimeKernel` and `ConfigService` as the lifecycle mechanisms. Add a co-located application lifecycle that consumes the existing core module outputs and owns agent-facing services, then make the transport lifecycle own listener configuration and shutdown. Runtime objects remain in `RuntimeContext`; Zustand remains lifecycle state only.

**Tech Stack:** Bun, TypeScript, RuntimeKernel, ConfigService, Zustand vanilla, `bun:test`.

## Global Constraints

- Preserve ACP, stdio, TCP loopback, Unix socket, channel, Mo, TLS, and hot-reload behavior.
- Do not introduce RxJS, a revision queue, a service locator, or runtime objects in Zustand.
- AgentLoop remains invoke-time; startup creates only `AgentExecutionService`.
- Use exact behavior and state-transition tests, not static existence assertions.
- Every module owns its watcher, reload, and cleanup behavior.

---

### Task 1: Application lifecycle boundary

**Files:**
- Create: `apps/monad/src/application/lifecycle.ts`
- Create: `apps/monad/test/unit/application/lifecycle.test.ts`
- Modify: `apps/monad/src/runtime/create.ts`

**Interfaces:**
- Produces `createApplicationLifecycleModule(options)` with explicit dependencies on store, sandbox, model, capabilities, atoms, skills, and MCP.
- Produces a stable `DaemonApplication` containing handlers, channels, locale, schedule, TLS state, config reload, and transport inputs.

- [ ] Write a failing test proving application startup receives core outputs in dependency order and application reload delegates to its owned reload facade.
- [ ] Run the focused test and observe the missing lifecycle module failure.
- [ ] Move agent execution, hooks, memory, commands, handlers, channels, and application reload assembly behind the lifecycle boundary.
- [ ] Run focused runtime/application tests and commit.

### Task 2: Transport lifecycle ownership

**Files:**
- Modify: `apps/monad/src/transports/lifecycle.ts`
- Create: `apps/monad/test/unit/transports/lifecycle-module.test.ts`
- Modify: `apps/monad/src/application/lifecycle.ts`

**Interfaces:**
- Produces `startDaemonTransports(application, options)` which owns network resolution, listeners, watcher activation, readiness, and shutdown.

- [ ] Write a failing test proving shutdown stops schedule, watchers, channels, config watching, and kernel in dependency order.
- [ ] Run the focused test and observe the missing transport composition API failure.
- [ ] Move TLS/network/listener/Mo and cleanup wiring into the transport lifecycle.
- [ ] Run TCP, Unix socket, listener, and transport lifecycle tests and commit.

### Task 3: Thin entrypoint and verification

**Files:**
- Modify: `apps/monad/src/main.ts`
- Modify: `apps/monad/src/runtime/create.ts`
- Test: existing daemon runtime, config, application, transport, and E2E suites.

**Interfaces:**
- `startDaemon(options)` performs process mode selection, preflight, runtime construction, runtime start, and delegates transport startup.

- [ ] Remove migrated initialization and late-bound reload callbacks from `main.ts`.
- [ ] Verify main contains only entrypoint orchestration and no domain service construction.
- [ ] Run Biome, typecheck collection, focused tests, daemon tests, main bundle, and `git diff --check`.
- [ ] Commit the completed simplification.
