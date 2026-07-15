# Behavior-Driven Test Assertions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace tests that only prove existence with tests of observable behavior and prevent new weak assertions.

**Architecture:** A repository audit classifies assertion patterns, while individual tests are rewritten at their existing behavior boundary. Legitimate absence contracts remain exact assertions rather than being suppressed or weakened.

**Tech Stack:** Bun, TypeScript, Bun test, Playwright, Biome

## Global Constraints

- Work directly on `main` as requested.
- Preserve all unrelated working-tree changes.
- Test observable behavior, state transitions, side effects, errors, and exact public contracts.
- Do not use source-text or entity-presence assertions as proxies for behavior.
- Preserve absence assertions when absence is the public contract.

---

### Task 1: Assertion audit

**Files:**
- Create: `scripts/test/unit/behavior-assertion-quality.test.ts`
- Modify: `docs/engineering/testing.md`

**Interfaces:**
- Consumes: repository test files discovered from the workspace
- Produces: a failing audit for weak positive-existence matchers and documented semantic rules

- [ ] **Step 1:** Write the audit test and run it to capture the current violations.
- [ ] **Step 2:** Document the observable-behavior and legitimate-absence boundary.
- [ ] **Step 3:** Run the audit again after Tasks 2 and 3 and require a clean result.

### Task 2: Runtime and service behavior tests

**Files:**
- Modify: `apps/monad/test/e2e/external-agent-runtimes-pagination.test.ts`
- Modify: `apps/monad/test/e2e/file-mcp.test.ts`
- Modify: `apps/monad/test/unit/store/migrations.test.ts`
- Modify: `packages/sandbox-vm/test/e2e/vm-conformance.test.ts`
- Modify: `packages/sandbox-vm/test/unit/baseline-cache.test.ts`
- Modify: `packages/sandbox-vm/test/unit/vsock-process.test.ts`
- Modify: `packages/sandbox/test/unit/manager.test.ts`

**Interfaces:**
- Consumes: existing public APIs and process boundaries
- Produces: exact pagination, tool execution, migration query, cache restore, terminal IO, violation stream, and sandbox environment behavior assertions

- [ ] **Step 1:** Replace each positive defined/truthy assertion with the result of using the capability or an exact contract comparison.
- [ ] **Step 2:** Run each changed test file with `scripts/bun-test.ts ... --only-failures`.

### Task 3: Browser interaction behavior tests

**Files:**
- Modify: `apps/web/test/e2e/sidebar-interactions.spec.ts`
- Review: `apps/web/test/unit/agent-flow-editor-contract.test.ts`
- Review: `apps/web/test/unit/atoms-settings-scroll.test.ts`
- Review: `apps/web/test/unit/inbox-route-mentions.test.ts`
- Review: `apps/web/test/unit/workspace-project-title-interaction.test.ts`

**Interfaces:**
- Consumes: user interactions and rendered application state
- Produces: assertions over created session/project behavior and real UI outcomes rather than source fragments or truthy lookup results

- [ ] **Step 1:** Replace truthy entity lookups with exact state transitions or subsequent user interactions.
- [ ] **Step 2:** Replace source-proxy tests where the same behavior can be exercised through exported logic or browser interaction.
- [ ] **Step 3:** Run changed Bun and Playwright tests with their focused runners.

### Task 4: Repository verification

**Files:**
- Verify: all changed files

**Interfaces:**
- Consumes: Tasks 1-3
- Produces: fresh quality-gate evidence

- [ ] **Step 1:** Run the assertion-quality audit over all test files.
- [ ] **Step 2:** Run `bun run lint`, `bun run typecheck`, and `bun run test`, collecting all failures before repair.
- [ ] **Step 3:** Rerun every repaired gate and report exact remaining baseline failures, if any.
