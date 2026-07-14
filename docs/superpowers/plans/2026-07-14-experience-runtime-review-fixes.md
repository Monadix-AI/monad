# Experience Runtime Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the six validated experience-runtime and Kanban lifecycle issues found during review.

**Architecture:** Preserve the pack-owned Kanban model while strengthening generic host boundaries. Event delivery becomes ordered, observations use a bounded neutral projection, session effects are idempotent, wakeups are experience-scoped, and Kanban commands validate explicit state transitions.

**Tech Stack:** TypeScript, Bun, bun:test, SQLite, Elysia.

## Global Constraints

- Keep generic host APIs free of Kanban-specific types.
- Keep pack state namespaced by atom pack, principal, project, and record key.
- Add a failing regression test before each production change.
- Do not weaken project ownership or manifest permission checks.

---

### Task 1: Ordered experience event delivery

**Files:**
- Modify: `apps/monad/src/atoms/experience-workers.ts`
- Modify: `apps/monad/src/handlers/daemon-handlers/index.ts`
- Test: `apps/monad/test/unit/atoms/experience-workers.test.ts`

**Interfaces:**
- Consumes: `ProjectExperienceEvent`, registered `ExperienceWorker` handlers.
- Produces: an enqueue operation that serializes events per session and continues after a failed handler.

- [ ] Write a test that enqueues two same-session events while the first handler is blocked and asserts ordered, non-overlapping delivery.
- [ ] Run `bun test apps/monad/test/unit/atoms/experience-workers.test.ts` and confirm the ordering test fails.
- [ ] Add the minimal per-session promise chain and route daemon events through it.
- [ ] Re-run the focused test and confirm it passes.

### Task 2: Safe observation projection

**Files:**
- Modify: `apps/monad/src/atoms/experience-project-sessions.ts`
- Test: `apps/monad/test/unit/atoms/experience-capabilities.test.ts`

**Interfaces:**
- Consumes: durable `Event` records.
- Produces: bounded observation summaries without serializing raw payload objects.

- [ ] Write a test with a secret-bearing tool payload and assert the returned observation omits it while retaining a safe summary.
- [ ] Run the test and confirm it fails by exposing the secret.
- [ ] Add a neutral event-to-observation mapper with bounded, allowlisted text.
- [ ] Re-run the focused test and confirm it passes.

### Task 3: Idempotent project-session messages

**Files:**
- Modify: `apps/monad/src/atoms/experience-project-sessions.ts`
- Test: `apps/monad/test/unit/atoms/experience-capabilities.test.ts`

**Interfaces:**
- Consumes: namespaced `sendMessage` idempotency keys.
- Produces: one `sessions.generate` side effect per session/key.

- [ ] Write a test that sends the same key twice and expects one generation.
- [ ] Run the test and confirm duplicate generation occurs.
- [ ] Persist a per-session message-effect record before generation and make retries no-ops after success or while in flight.
- [ ] Re-run the focused test and confirm it passes.

### Task 4: Experience-scoped wakeups

**Files:**
- Modify: `packages/sdk-atom/src/index.ts`
- Modify: `apps/monad/src/handlers/atom-pack/experience-capabilities.ts`
- Modify: `apps/monad/src/atoms/experience-state.ts`
- Modify: `apps/monad/src/atoms/experience-workers.ts`
- Modify: `apps/monad/src/store/db/experience-worker-wakeups.ts`
- Modify: `apps/monad/src/store/db/migrations.ts`
- Modify: `apps/monad/src/store/db/schema.ts`
- Test: `apps/monad/test/unit/atoms/experience-workers.test.ts`

**Interfaces:**
- Consumes: `ExperienceWorker.experienceId`.
- Produces: scheduler and persisted wakeup identity scoped by `atomPackId`, `principalId`, `experienceId`, `projectId`, and `key`.

- [ ] Write a test registering two workers in one pack and assert each receives only its own same-key wakeup.
- [ ] Run the test and confirm the first worker receives or overwrites the second worker's wakeup.
- [ ] Thread `experienceId` through worker contexts, scheduler construction, persistence, and lookup.
- [ ] Re-run focused SDK and worker tests and confirm they pass.

### Task 5: Correct Kanban controls and validation

**Files:**
- Modify: `packages/monad-power-pack/src/experiences/kanban/domain.ts`
- Modify: `packages/monad-power-pack/src/experiences/kanban/api.ts`
- Modify: `packages/monad-power-pack/src/experiences/kanban/worker.ts`
- Test: `packages/monad-power-pack/test/unit/kanban-api.test.ts`
- Test: `packages/monad-power-pack/test/unit/kanban-worker.test.ts`

**Interfaces:**
- Consumes: explicit proposal, execution, approval, and acceptance commands.
- Produces: rejected unknown commands and a paused task that is not runnable until resume.

- [ ] Write tests for unknown command rejection and pause-without-dispatch.
- [ ] Run the tests and confirm current fallback behavior fails them.
- [ ] Add explicit allowlist parsers plus a paused execution state and resume transition.
- [ ] Re-run Kanban unit tests and confirm they pass.

### Task 6: Verification

**Files:**
- Verify all modified source and tests.

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces: verified review fixes with no focused regressions.

- [ ] Run focused unit tests for workers, capabilities, Kanban, SDK atom, and SDK experience.
- [ ] Run typechecks for `apps/monad`, `apps/web`, `packages/monad-power-pack`, `packages/sdk-atom`, and `packages/sdk-experience`.
- [ ] Run the transport E2E tests for workspace experience APIs and Kanban.
- [ ] Inspect `git diff --check` and the final scoped diff.
