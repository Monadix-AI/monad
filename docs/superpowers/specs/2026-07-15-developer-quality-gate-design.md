# Developer Quality Gate Design

## Goal

Make local setup and commit verification predictable without weakening the repository's existing policy: `bun install` remains the one-step initializer, pre-commit only checks and blocks, and syncpack, knip, dependency-direction, generated-artifact, database, and TypeScript failures all block the commit.

## Command contract

The root package exposes four distinct operations:

- `bun run setup` reruns the idempotent developer initializer used by `postinstall`.
- `bun run quality:fix` performs the approved automatic repairs: syncpack formatting, Biome writes, and generated-artifact refreshes.
- `bun run quality:check` performs only read-only checks and is the canonical CI gate.
- `bun run quality:precommit` performs the same read-only gate as CI and never modifies or stages files.

`knip` never runs with `--fix`. A knip finding blocks the commit and requires an intentional source edit.

## Gate execution

The explicit `quality:fix` command runs mutations sequentially because syncpack, Biome, and generators may touch overlapping files. The check gate collects every failure instead of stopping at the first command. Independent read-only checks may run concurrently, but their output is rendered in a stable command order.

The canonical read-only checks are Biome, syncpack, knip, dependency direction, agent-rule drift, i18n drift, database history, database drift, generated artifacts, and TypeScript. The pre-commit entry may use the existing staged TypeScript optimization; CI runs the complete workspace typecheck. Tests remain a separate CI matrix because they are cross-platform and materially more expensive than the commit gate.

## Dependency policy

`packages/*` must never depend on `apps/*`. Apps are leaf executables except for explicitly recorded composition edges. `@monad/cli` is the release composition root and may depend on the daemon, TUI, and web application. Any other app-to-app dependency must either be removed or recorded with a narrow rationale. Runtime dependencies and development-only dependencies are reported separately.

The checker reads this policy from a typed configuration exported by the script, so tests can assert both accepted composition edges and rejected unrecorded edges.

## One-step initialization

`bun install` continues to invoke the initializer. The initializer reports named stages, is safe to rerun, and produces one final summary. Core worktree state remains isolated: environment files, daemon data, ports, CLI shims, and generated artifacts.

Phoenix remains a deliberately shared heavyweight service. Initialization serializes Phoenix startup, verifies that an existing fixed-name container is the expected image, and never lets one worktree stop the shared service. Telemetry identifies its source worktree through resource attributes. CodeGraph initialization follows the repository instruction: it is reported when available but indexing remains an explicit project-owner action.

Dev shutdown terminates the process group it created. It never finds and kills arbitrary processes merely because they occupy a configured port. A port still occupied after shutdown is reported with an actionable diagnostic.

## Diagnostics

`bun run dev:doctor` is read-only. It verifies the pinned Bun version, installed workspace dependencies, environment initialization, CLI shim target, configured port availability, and required generated artifacts. Every failing item includes its repair command; missing dependencies must say `bun install` rather than falling through to an unrelated package-manager error. The initializer itself reports the optional shared Phoenix and CodeGraph status because neither is a core development prerequisite.

## CI and documentation

CI invokes `bun run quality:check`, then the cross-platform test matrix, and verifies that the gate did not modify the checkout. Documentation describes Vite and TanStack Router, the actual initializer, the exact gate, and CodeGraph's conditional availability. Claims about Codespaces or committed generated agent files must match files that exist in the repository.

## Acceptance criteria

- `bun install && bun run dev` remains the complete onboarding path.
- Pre-commit never applies or stages repairs; developers invoke `quality:fix` explicitly.
- knip, syncpack, dependency, database, generated-file, i18n, agent-rule, and TypeScript findings block commits.
- CI and pre-commit consume one check definition.
- Read-only check mode leaves `git diff` unchanged.
- Multiple worktrees do not kill each other's or unrelated processes.
- Missing prerequisites produce a direct repair command.
