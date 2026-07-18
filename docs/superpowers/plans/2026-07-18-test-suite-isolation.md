# Test Suite Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split Monad CI into unit, hermetic E2E, pinned third-party dependency, and live-provider failure domains.

**Architecture:** Add a small pure suite-argument parser used by `scripts/bun-test.ts`, make coverage explicitly opt-in, and route package/CI commands through distinct test processes. Preserve the existing container and nightly integrations.

**Tech Stack:** Bun test, TypeScript, Turbo, GitHub Actions YAML

## Global Constraints

- Hermetic E2E must exclude `live-*.test.ts`, `*.local.test.ts`, and `*.container*.test.ts` before module loading.
- Live provider tests must not become a pull-request gate.
- Linux unit tests alone enable coverage by default in CI.
- `bun run test` remains an aggregate local command.

---

### Task 1: Suite classification

**Files:**
- Create: `scripts/lib/test-suite.ts`
- Create: `scripts/test/unit/test-suite.test.ts`
- Modify: `scripts/bun-test.ts`

**Interfaces:**
- Produces: `parseMonadTestSuiteArgs(args: string[]): { args: string[]; ignorePatterns: string[] }`

- [ ] Write tests proving hermetic E2E strips its wrapper argument and returns live/local ignore patterns.
- [ ] Run `bun test scripts/test/unit/test-suite.test.ts` and confirm the missing module failure.
- [ ] Implement the parser and integrate its output into the Bun runner.
- [ ] Change coverage activation from generic `CI` to `MONAD_TEST_COVERAGE=1`.
- [ ] Rerun the focused unit test and confirm it passes.

### Task 2: Package command boundaries

**Files:**
- Modify: `apps/monad/package.json`
- Modify: `package.json`
- Modify: `packages/protocol/package.json`
- Modify: `packages/utils/package.json`
- Modify: `turbo.jsonc`

**Interfaces:**
- Produces: `test:e2e:hermetic` package commands and an aggregate `test` that uses separate processes.

- [ ] Route `apps/monad` aggregate tests through `test:unit` followed by `test:e2e:hermetic`.
- [ ] Make daemon E2E commands invoke the hermetic suite option.
- [ ] Add missing `test:unit` aliases for Protocol and Utils, and include `scripts/test/unit` in the root unit command.
- [ ] Add `MONAD_TEST_COVERAGE` to Turbo's global environment hash.
- [ ] Check the resulting package JSON files parse successfully.

### Task 3: CI failure domains

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/nightly.yml`

**Interfaces:**
- Produces: independent `unit`, `hermetic-e2e`, `e2e-deps`, and `live-e2e` jobs.

- [ ] Replace the mixed cross-platform test job with a cross-platform unit job.
- [ ] Add a cross-platform hermetic E2E job containing launcher setup and platform checks.
- [ ] Enable `MONAD_TEST_COVERAGE=1` only for Linux unit execution.
- [ ] Add the omitted `live-hooks.test.ts` suite to nightly live E2E.
- [ ] Parse both workflow files as YAML and inspect the resulting job keys.

### Task 4: Verification

**Files:**
- Verify all modified files.

**Interfaces:**
- Consumes: all commands and workflow boundaries from Tasks 1-3.

- [ ] Run the suite-parser unit test.
- [ ] Run the hermetic E2E command far enough to verify collection excludes live/local suites; if dependencies are unavailable, report that environmental blocker exactly.
- [ ] Run Biome on changed TypeScript/JSON files.
- [ ] Review `git diff --check`, the final diff, and workflow job names.
