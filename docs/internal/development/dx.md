---
title: "Developer Experience (DX)"
audience: "internal-developer"
description: "How this repo keeps the edit→verify loop fast, and the rules for keeping it that way. The tool inventory is in tech-stack.md; the worktree/environment."
---
How this repo keeps the edit→verify loop fast, and the rules for keeping it that way.
The tool inventory is in [the technology stack](../../engineering/tech-stack.md); the worktree and environment
procedure is in [worktree development](worktree.md); test conventions are in
[testing](testing.md). This doc is about the **experience**: what a developer (human
or agent) should be able to expect, which loops are budgeted, and what to do when a
loop degrades.

---

## Principles

1. **Zero manual setup.** `bun install && bun run dev` in a fresh worktree is the entire
   onboarding. Anything a developer must remember to do by hand (copy a file, pick a
   port, export a variable) is a DX bug — automate it in `postinstall`
   (`scripts/dev-init.ts`) or the Turbo task graph.
2. **Parallel by default.** Any number of worktrees run `bun run dev` at once without
   coordination: ports, `MONAD_HOME`, CLI shims, and caches are all per-worktree (or
   deliberately shared, like the Bun transpiler cache). A feature that only works in
   one checkout at a time breaks the [parallel agent](../agents/parallel-agents.md) workflow.
3. **Fast feedback beats complete feedback.** The inner loop uses the cheapest signal
   that can catch the mistake: hot reload before restart, `tsc` before a build,
   a scoped `bun-test.ts` run before the full suite. Full verification happens once,
   at the gate — not on every keystroke.
4. **Failures must be self-explanatory.** When a loop breaks, the error should name the
   fix (`Daemon is not running. Start it with: bun run dev`). A stack trace with no
   next action is a DX bug even when the code is "correct".
5. **Everything scriptable.** Every dev task is a `bun run <script>` from the repo
   root — no memorized incantations, no tools that only work interactively. If you did
   something useful twice from the shell, it belongs in `scripts/` or `package.json`.

---

## The feedback loops, and their budgets

Ordered from tightest to widest. Reach for the tightest loop that can catch your
mistake; escalate only when it can't.

| Loop | Command | Budget | Catches |
|---|---|---|---|
| Hot reload | save the file (`bun run dev` running) | seconds | daemon config/skill/atom changes, Vite UI edits |
| Typecheck | `bun run typecheck` (TypeScript 7 `tsc`) | tens of seconds | type errors across the workspace |
| Scoped tests | `bun scripts/bun-test.ts <dir> --only-failures` | seconds–minutes | the package you're editing |
| Lint | `bun run lint` (Biome, auto-fixes) | seconds | style, correctness lints |
| Commit gate | Lefthook | seconds | staged-file fixes and checks only |
| Full gate | `mise run quality:check` + `bun run test` | minutes | everything, pre-merge only |
| Cross-OS | CI matrix (Ubuntu/macOS/Windows), `mise run docker:test:*` | CI-time | platform drift, musl, install scripts |

Budget regressions are bugs. If `bun run dev` cold-start or the unit suite gets
noticeably slower, treat it like a performance regression per
[performance guidelines](performance-guidelines.md): measure, find the dominant
cost, fix or record it.

### Quality-gate etiquette

`quality:check` collects the complete failure surface without modifying or staging
files. Knip is check-only: it never receives `--fix`. Use `quality:fix` explicitly
when you want syncpack, Biome, and generated inputs repaired. Tests remain a separate
matrix because transport and platform behavior must run on Linux, macOS, and Windows.

Mise owns the quality dependency graph and parallel execution. `package.json` exposes
only the two stable public commands; inspect the implementation with
`mise tasks deps quality:check` and run an individual check with
`mise run quality:<name>`.

---

## What the automation does for you

So you know what you should *never* be doing by hand:

- **`bun install` (postinstall → `scripts/dev-init.ts`)** — creates/migrates
  `.env.local`, assigns this worktree stable ports (`MONAD_PORT`, `WEB_PORT`,
  `MONAD_KV_UI_PORT`, derived from the checkout path), regenerates `.dev/bin` CLI shims
  with this worktree's absolute paths. Idempotent; never clobbers a value you set.
- **`bun run dev`** — runs generated-artifact tasks and persistent daemon, web,
  Storybook, and devtools tasks through `turbo watch`. Bun loads `.env.local`; Turbo
  owns task ordering, restarts, and child-process cleanup.
- **mise shell hook** — switches Bun to the version pinned in `package.json`, loads
  `.env.local`, and adds the current worktree's `.dev/bin` on every `cd`. Setup:
  [worktree development §0](worktree.md#0-one-time-machine-setup).
- **`bun run test` / `typecheck`** — regenerate i18n types (`i18n:types`) first, so
  locale keys are never stale when you run the suite.
- **Git hooks (Lefthook)** — see next section.

If one of these breaks (shims pointing at another worktree, port collisions, `PORT`
falling back to 3000), the recovery reference is
[worktree development Part 2](worktree.md#part-2--environment-reference).

## Git hooks

Lefthook runs these automatically; know what they are so hook failures aren't
mysterious:

| Hook | What runs |
|---|---|
| `pre-commit` | concurrent staged-only Biome fixes, TypeScript checks, and package manifest checks |
| `commit-msg` | commitlint — Conventional Commits format is enforced, not advisory |
| `post-merge` / `post-checkout` / `post-rewrite` | `sync-after-git.sh` re-syncs dependencies and code generation when the tree moved under you |

Two implications:

- A commit that fails the hook is telling you something the gate would also catch —
  fix it, don't `--no-verify` (reserve that for genuine hook bugs, and then fix the hook).
- The hook temporarily hides every unstaged and untracked change. It repairs and
  re-stages only supported staged files, including Biome unsafe fixes. Run
  `mise run quality:fix` when you want to repair the entire checkout.
- Knip only reports unused code. Remove or export code intentionally; the hook never
  uses `knip --fix`.

## Generated files — edit the source, run the sync

Several files in the repo are build artifacts of other files. Editing them directly is
lost work; each has a sync command:

| Generated | Source of truth | Sync |
|---|---|---|
| `CLAUDE.md`, `AGENTS.md`, other agent files | `.rulesync/rules/` | `bun run agents:sync` |
| i18n type definitions (`packages/i18n/src/catalog-types.ts`) | `packages/i18n/src/locales/<lng>/<namespace>.json` | `mise run i18n:types` (auto-run by test/typecheck) |
| license inventory | production dependency graph via `license-checker-rseidelsohn` | `bun run generate` |
| codex app-server protocol types | upstream protocol spec | `bun run generate` |

`mise run quality:check` delegates the dependency graph and parallel execution to mise.
It refreshes ignored build inputs, then runs the agent-rule and i18n checks with the
rest of the gate. Tracked files must remain unchanged.

## Navigating the codebase

### Inspect the local daemon API with Scalar

The public Mintlify site intentionally does not publish the daemon's OpenAPI document.
For a route-accurate reference while developing, enable developer mode in the current
worktree and open the Scalar URL reported by the daemon:

```bash
monad config set developerMode true
monad restart
monad status
```

Scalar is served at `http://127.0.0.1:<MONAD_PORT>/docs`; its OpenAPI JSON is at
`/docs/json`. The document includes internal routes and describes the current checkout,
not a stable public API version. Route-authored operation metadata is preserved, and the
transport fills missing summaries, descriptions, and tags so newly added routes remain
navigable during development.

Disable developer mode when the inspection is complete. Do not proxy this endpoint to a
public host.

- **CodeGraph first when indexed.** If `.codegraph/` exists, `codegraph explore
  "<question or symbols>"` answers most "how does X work / who calls Y" questions in
  one call, cheaper and more accurately than a grep+read crawl. If the directory is
  absent, use normal search; indexing is an explicit project-owner decision.
- **Docs are the second index.** Every focused concern has a doc under `docs/`
  referenced from `AGENTS.md`. When you learn something the docs
  don't say (a gotcha, an accepted trade-off, a "why is it like this"), the fix is a
  doc edit in the same PR — the next developer shouldn't re-derive it.

## When DX degrades

DX bugs are bugs. File and fix them like functional ones:

- **Reproduce with a number** — cold-start seconds, suite minutes, steps of manual
  setup. "Feels slow/annoying" doesn't prioritize.
- **Fix at the automation layer**, not in your shell profile. A workaround that lives
  in one developer's environment is a trap for the next one (and violates the
  no-private-env-vars rule in [code conventions](conventions.md)).
- **Record accepted costs.** If a slow loop is a deliberate trade-off, write it down
  (here, or in the relevant doc's "known bottlenecks" section) so nobody
  re-investigates it.

### Known DX gotchas

Current, verified traps — remove entries when the underlying cause is fixed:

- **Stale `.dev/bin` shims** silently run *another worktree's* source. Always
  `bun install && bun run dev` first in a fresh worktree; never copy `.env.local`
  between worktrees. ([worktree development](worktree.md))
- **`bun` exiting 137** under sandboxed test runs is the sandbox OOM-killing the
  process, not a test failure — re-run with the sandbox disabled.
- **Phoenix is opt-in.** Run `mise run dev:services` to start the shared Compose
  service. Installing dependencies never starts containers.
- Run `mise run dev:doctor` when setup is incomplete or a worktree points at stale
  generated files, shims, or ports.
