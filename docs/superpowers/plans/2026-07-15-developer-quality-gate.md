# Developer Quality Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a single, trustworthy developer quality gate while preserving one-step setup and blocking commits on all required checks.

**Architecture:** A typed Bun orchestrator owns ordered fix and check command definitions shared by Lefthook and CI. Small testable modules own dependency-policy evaluation, developer diagnostics, and local-service/process ownership; package scripts are stable adapters over those modules.

**Tech Stack:** Bun 1.3.14, TypeScript 7, Lefthook, Biome, syncpack, knip, Turbo, GitHub Actions.

## Global Constraints

- `bun install` remains the one-step initializer.
- Biome and syncpack may repair files before commit.
- knip is check-only and never receives `--fix`.
- Required quality findings block commit.
- CI check mode is read-only.
- Unknown processes are never killed by port number.

---

### Task 1: Dependency policy

**Files:**
- Modify: `scripts/check-deps.ts`
- Create: `scripts/test/unit/check-deps.test.ts`

**Interfaces:**
- Produces: `checkDependencyDirections(packages, policy): DependencyViolation[]` and the CLI's existing zero/non-zero behavior.

- [x] Write tests for package-to-app rejection, the CLI composition allowlist, and unrecorded app-to-app rejection.
- [x] Run `bun test scripts/test/unit/check-deps.test.ts` and confirm the new exports are missing.
- [x] Extract the evaluator and encode narrow CLI composition edges with reasons.
- [x] Run the focused test and `bun run check:deps`; both must exit zero.

### Task 2: Quality-gate orchestrator

**Files:**
- Create: `scripts/quality-gate.ts`
- Create: `scripts/quality-gate/commands.ts`
- Create: `scripts/quality-gate/runner.ts`
- Create: `scripts/test/unit/quality-gate.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `qualityGateCommands(mode)`, `runQualityGate(mode, deps)`, and root scripts `quality:fix`, `quality:check`, `quality:precommit`.

- [x] Write tests proving knip is read-only, fixes precede checks, every failure is collected, and check mode contains no mutating command.
- [x] Run the focused test and confirm it fails because the modules do not exist.
- [x] Implement typed command definitions and a stable-output runner.
- [x] Add root scripts while retaining `lint` as the auto-fixing developer command and adding `lint:check`.
- [x] Run focused tests and dry-run command rendering.

### Task 3: Hook and CI adoption

**Files:**
- Modify: `lefthook.yml`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/test/unit/quality-gate.test.ts`

**Interfaces:**
- Consumes: `bun run quality:precommit` and `bun run quality:check` from Task 2.

- [x] Add contract tests that read Lefthook and CI configuration and assert the shared entrypoints.
- [x] Run the test and confirm the old inline commands fail the assertions.
- [x] Replace parallel mutating hook jobs with the orchestrated pre-commit entry.
- [x] Replace duplicated CI checks with `quality:check` and add `git diff --exit-code`.
- [x] Run the focused contract tests.

### Task 4: Safe initializer and shutdown ownership

**Files:**
- Modify: `scripts/dev-init/dev-services.ts`
- Modify: `scripts/dev-init.ts`
- Modify: `scripts/dev-prep.ts`
- Modify: `scripts/test/unit/dev-init.test.ts`
- Modify: `scripts/test/unit/dev-prep.test.ts`

**Interfaces:**
- Produces: explicit CodeGraph status without automatic indexing, Phoenix identity validation, and owned-process-only cleanup.

- [x] Write tests asserting CodeGraph is not initialized automatically and shutdown never invokes a port-based killer.
- [x] Run focused tests and confirm current behavior violates them.
- [x] Remove automatic CodeGraph initialization and arbitrary `lsof`/`SIGKILL` cleanup.
- [x] Add an actionable occupied-port warning after owned process cleanup.
- [x] Validate an existing Phoenix container's image before reusing it and serialize startup with a filesystem lock.
- [x] Run both focused test files.

### Task 5: Developer doctor

**Files:**
- Create: `scripts/dev-doctor.ts`
- Create: `scripts/dev-doctor/checks.ts`
- Create: `scripts/test/unit/dev-doctor.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `runDevDoctor(root, deps): Promise<DoctorResult[]>` and `bun run dev:doctor`.

- [x] Write tests for missing `node_modules`, Bun version mismatch, absent `.env.local`, stale shim, occupied port, and healthy setup.
- [x] Run the test and confirm the module is missing.
- [x] Implement read-only checks with one repair command per failure.
- [x] Add the root command and run focused tests.

### Task 6: Documentation alignment

**Files:**
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `.env.example`
- Modify: `docs/engineering/dx.md`
- Modify: `docs/engineering/worktree.md`
- Modify: `docs/engineering/tech-stack.md`
- Modify: `docs/engineering/performance-guidelines.md`
- Replace: `docs/internals/web-router.md`
- Modify: `docs/README.md`
- Modify: `docs/engineering/conventions.md`

**Interfaces:**
- Documents the commands and policies produced by Tasks 1-5.

- [x] Replace stale Next.js/setup-dev/Codespaces/AGENTS claims with current Vite, TanStack Router, initializer, and gate behavior.
- [x] Document the two-phase pre-commit gate and check-only knip policy.
- [x] Document shared Phoenix and explicit CodeGraph ownership.
- [x] Run repository searches proving stale framework and command claims are removed.

### Task 7: Verification

**Files:**
- No production changes expected.

- [x] Run all new focused unit tests.
- [x] Run `bun run check:deps`.
- [x] Run `bun run quality:check` and inspect every command result.
- [ ] Run `bun run test`, `bun run typecheck`, and `bun run lint:check` freshly.
- [x] Run `git diff --check` and inspect `git status --short`.
- [x] Compare the final diff line-by-line against the design acceptance criteria.
