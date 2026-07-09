# Developer experience (DX)

How this repo keeps the edit→verify loop fast, and the rules for keeping it that way.
The tool inventory is in [tech-stack.md](tech-stack.md); the worktree/environment
procedure is in [worktree.md](../worktree.md); test conventions are in
[testing.md](testing.md). This doc is about the **experience**: what a developer (human
or agent) should be able to expect, which loops are budgeted, and what to do when a
loop degrades.

---

## Principles

1. **Zero manual setup.** `bun install && bun run dev` in a fresh worktree is the entire
   onboarding. Anything a developer must remember to do by hand (copy a file, pick a
   port, export a variable) is a DX bug — automate it in `postinstall`
   (`scripts/dev-init.ts`) or the dev prep launcher (`scripts/dev-prep.ts`).
2. **Parallel by default.** Any number of worktrees run `bun run dev` at once without
   coordination: ports, `MONAD_HOME`, CLI shims, and caches are all per-worktree (or
   deliberately shared, like the Bun transpiler cache). A feature that only works in
   one checkout at a time breaks the [parallel-agents](../parallel-agents.md) workflow.
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
| Hot reload | save the file (`bun run dev` running) | seconds | daemon config/skill/atom changes, Next.js UI edits |
| Typecheck | `bun run typecheck` (TypeScript 7 `tsc`) | tens of seconds | type errors across the workspace |
| Scoped tests | `bun scripts/bun-test.ts <dir> --only-failures` | seconds–minutes | the package you're editing |
| Lint | `bun run lint` (Biome, auto-fixes) | seconds | style, correctness lints |
| Full gate | `typecheck` + `lint` + `bun run test` | minutes | everything, pre-merge only |
| Cross-OS | CI matrix (Ubuntu/macOS/Windows), `docker:test:*` | CI-time | platform drift, musl, install scripts |

Budget regressions are bugs. If `bun run dev` cold-start or the unit suite gets
noticeably slower, treat it like a performance regression per
[performance-guidelines.md](../performance-guidelines.md): measure, find the dominant
cost, fix or record it.

### Quality-gate etiquette

Run the gate as **one failure-collection pass**: typecheck, lint, and tests once each,
record every failure, then make a single concentrated repair pass. Do not ping-pong
between one failing command and one fix — that turns a minutes-long gate into an
hour-long one. (Same rule as [AGENTS.md](../../AGENTS.md) and
[testing.md](testing.md).)

---

## What the automation does for you

So you know what you should *never* be doing by hand:

- **`bun install` (postinstall → `scripts/dev-init.ts`)** — creates/migrates
  `.env.local`, assigns this worktree stable ports (`MONAD_PORT`, `WEB_PORT`,
  `MONAD_KV_UI_PORT`, derived from the checkout path), regenerates `.dev/bin` CLI shims
  with this worktree's absolute paths. Idempotent; never clobbers a value you set.
- **`bun run dev` (`scripts/dev-prep.ts`)** — mirrors `WEB_PORT` → `PORT` for Next.js,
  points Bun's transpiler cache at a shared `~/.cache/monad-bun`, then starts turbo's
  persistent daemon + web tasks.
- **mise shell hook** — switches Bun to the version pinned in `package.json`
  `packageManager` on every `cd`. Setup: [worktree.md §0](../worktree.md).
- **`bun run test` / `typecheck`** — regenerate i18n types (`i18n:types`) first, so
  locale keys are never stale when you run the suite.
- **Git hooks (Lefthook)** — see next section.

If one of these breaks (shims pointing at another worktree, port collisions, `PORT`
falling back to 3000), the recovery reference is
[worktree.md Part 2](../worktree.md#part-2--environment-reference).

## Git hooks

Lefthook runs these automatically; know what they are so hook failures aren't
mysterious:

| Hook | What runs |
|---|---|
| `pre-commit` | knip (dead-export removal), Biome check `--write` on staged files, syncpack lint+format, typecheck of staged `*.ts(x)` |
| `commit-msg` | commitlint — Conventional Commits format is enforced, not advisory |
| `post-merge` / `post-checkout` / `post-rewrite` | `sync-after-git.sh` re-syncs deps/codegen when the tree moved under you; `direnv allow` on branch switch |

Two implications:

- A commit that fails the hook is telling you something the gate would also catch —
  fix it, don't `--no-verify` (reserve that for genuine hook bugs, and then fix the hook).
- Because `pre-commit` auto-fixes and re-stages, review `git diff --staged` after a
  hook run before assuming your commit contains only what you wrote.

## Generated files — edit the source, run the sync

Several files in the repo are build artifacts of other files. Editing them directly is
lost work; each has a sync command:

| Generated | Source of truth | Sync |
|---|---|---|
| `CLAUDE.md`, `AGENTS.md`, other agent files | `.rulesync/rules/` | `bun run agents:sync` |
| i18n type definitions | `packages/i18n/src/en.json` + locale packs | `bun run i18n:types` (auto-run by test/typecheck) |
| license inventory | dependency tree | project hook |
| codex app-server protocol types | upstream protocol spec | project hook |

`bun run agents:check` and `bun run i18n:check` verify sync without writing — CI runs
them, so a hand-edited artifact fails fast instead of silently diverging.

## Navigating the codebase

- **CodeGraph first.** The repo is indexed (`.codegraph/`); `codegraph explore
  "<question or symbols>"` answers most "how does X work / who calls Y" questions in
  one call, cheaper and more accurately than a grep+read crawl. Fall back to grep only
  to confirm a detail the graph didn't cover.
- **Docs are the second index.** Every focused concern has a doc under `docs/`
  referenced from [AGENTS.md](../../AGENTS.md). When you learn something the docs
  don't say (a gotcha, an accepted trade-off, a "why is it like this"), the fix is a
  doc edit in the same PR — the next developer shouldn't re-derive it.

## When DX degrades

DX bugs are bugs. File and fix them like functional ones:

- **Reproduce with a number** — cold-start seconds, suite minutes, steps of manual
  setup. "Feels slow/annoying" doesn't prioritize.
- **Fix at the automation layer**, not in your shell profile. A workaround that lives
  in one developer's environment is a trap for the next one (and violates the
  no-private-env-vars rule in [conventions.md](../conventions.md)).
- **Record accepted costs.** If a slow loop is a deliberate trade-off, write it down
  (here, or in the relevant doc's "known bottlenecks" section) so nobody
  re-investigates it.

### Known DX gotchas

Current, verified traps — remove entries when the underlying cause is fixed:

- **Stale `.dev/bin` shims** silently run *another worktree's* source. Always
  `bun install && bun run dev` first in a fresh worktree; never copy `.env.local`
  between worktrees. ([worktree.md](../worktree.md))
- **`bun` exiting 137** under sandboxed test runs is the sandbox OOM-killing the
  process, not a test failure — re-run with the sandbox disabled.
- **Next.js only honors `PORT`**, not `WEB_PORT`; that bridging lives in
  `scripts/dev-prep.ts`. Don't start the web app directly with `next dev` and expect the
  per-worktree port.
