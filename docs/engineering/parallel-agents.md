# Parallel Agent Development

This guide is for engineers or orchestrator agents driving multiple coding agents
simultaneously toward a shared feature set. For single-agent worktree basics see
[worktree.md](worktree.md); this document focuses on the extra problems parallelism
introduces: task decomposition, coordination, conflict prevention, integration, and cleanup.

---

## Core principles

1. **Never develop in the main checkout** — all work happens inside a worktree on a dedicated branch; the main checkout is read-only working state.
2. **One agent, one worktree, one branch** — isolation is a correctness requirement, not an option.
3. **Decompose before you launch** — do not start any agent until you have written down which files each one owns.
4. **Parallel ≠ unordered** — tasks with dependencies must run sequentially, even if that means waiting.
5. **Main is always the source of truth** — agent branches rebase regularly; long-lived drift is not allowed.

---

## 1. Task decomposition

### 1.1 Draw a file-ownership map

Before launching any agent, list the files each subtask will **read and write**. Two tasks
that share a file cannot truly run in parallel — make them sequential, or redraw the boundary.

```
Task A: packages/store/schema.ts, packages/store/migrations/
Task B: packages/protocol/types.ts, packages/protocol/codec.ts
Task C: apps/cli/commands/session.ts
```

A, B, and C have no overlap → safe to parallelize.

### 1.2 Identify hidden dependencies

No overlapping files does not mean no dependency:

- Task B's output types are consumed by Task C → B must finish before C starts.
- Task A adds a migration file → other agents see it only after rebasing; running `bun run test` earlier may fail spuriously.

Write all dependencies into `TASKS.md` (see next section). Do not keep them in your head.

### 1.3 Team-size guidance

| Parallel agents | Suitable for |
|---|---|
| 2–3 | Most feature work: one backend, one frontend, one tests/docs |
| 4–5 | Larger refactors: one agent per package along package boundaries |
| 6+ | Requires a task queue and explicit scheduling; beyond this, manual coordination cost exceeds the benefit |

---

## 2. Coordination file: TASKS.md

Maintain a `TASKS.md` at the root of the **main checkout** that every agent and human can
read for overall progress. Keep the format machine-readable so agents can update their own
status:

```markdown
# Parallel task board

## In progress
- [ ] feat/store-schema    @agent-a  store migrations + type definitions
- [ ] feat/protocol-codec  @agent-b  add SessionResume message type

## Blocked
- [ ] feat/cli-resume      @agent-c  waiting for feat/protocol-codec

## Done
- [x] feat/web-banner      @agent-d  merged 2026-06-17
```

Rules:
- An agent moves its row from "unassigned" to "in progress" when it starts.
- An agent marks its row "awaiting review" when the PR is pushed.
- A human or orchestrator marks it "done" after merge.
- Keep implementation details out of TASKS.md — those belong in the PR description.

---

## 3. Worktree setup

### 3.1 Create

Run from the **main checkout** (never create a worktree inside another worktree):

```sh
# git worktree add <path> -b <branch>
git worktree add ../monad-store-schema   -b feat/store-schema
git worktree add ../monad-protocol-codec -b feat/protocol-codec
git worktree add ../monad-cli-resume     -b feat/cli-resume
```

> **Never branch off main directly.** All development happens inside a worktree on a
> dedicated branch. Do not run `git checkout -b feat/…` inside the main checkout and
> start coding there — always create a worktree first and do the work inside it.

Naming conventions:
- Path: `../monad-<feature>`, placed **alongside** the main checkout (not inside it).
- Branch: `feat/<feature>` / `fix/<issue>` / `refactor/<scope>`.

### 3.2 Initialize each worktree

After entering a worktree, **do this first and nothing else**:

```sh
cd ../monad-<feature>
bun install
bun run dev
```

`bun run dev` assigns this worktree its own ports and generates `.env.local` automatically.
It never conflicts with other worktrees. See [worktree.md Part 2](worktree.md#part-2--environment-reference).

### 3.3 List all active worktrees

```sh
git worktree list
```

Example output:

```
/Users/you/Projects/monad               abc1234  [main]
/Users/you/Projects/monad-store-schema  def5678  [feat/store-schema]
/Users/you/Projects/monad-protocol-codec 9ab0cd  [feat/protocol-codec]
```

---

## 4. Launching agents

Open a **separate terminal tab or tmux pane** for each worktree:

```sh
# Pane 1
cd ../monad-store-schema && claude

# Pane 2
cd ../monad-protocol-codec && claude

# Pane 3 — start only after agent-b finishes
cd ../monad-cli-resume && claude
```

Each agent's launch prompt must include:
1. Task boundary — what to do, and explicitly what **not** to touch.
2. Success criteria — what "done" means (tests green, typecheck clean, PR pushed).
3. Interface contracts with other agents (e.g. "do not modify the `Session*` types in
   `packages/protocol/types.ts` — those are owned by agent-b").

---

## 5. Keeping branches in sync with main

Branches silently drift during parallel work. Rebase every half-day or whenever a key
upstream dependency merges, inside the relevant worktree:

```sh
git fetch origin
git rebase origin/main
```

After resolving any conflicts:

```sh
git add <resolved-files>
git rebase --continue
```

Then re-run the quality gate to confirm main's changes didn't break this branch:

```sh
bun run typecheck
bun run lint
bun run test
```

> **Why rebase, not merge?** Keeps a linear history so squash-merging into main produces a
> clean commit graph with no merge bubbles.

---

## 6. Interface changes between agents

When an agent needs to modify a public interface that another agent depends on (protocol
types, exported function signatures, DB schema), it must:

1. Note the change in TASKS.md on its own row ("interface change: SessionResume added").
2. List the breaking change and migration steps in its PR description.
3. Downstream agents rebase onto the main that contains that merged PR before continuing.

Never let two agents modify the same public interface simultaneously — this is the most
common merge landmine.

---

## 7. Integration and merge order

### 7.1 Independent branches: any order

When branches touch entirely different files, GitHub's squash merge performs a clean
three-way merge automatically.

### 7.2 Dependent branches: sequential merge

```
feat/store-schema   ──merge──▶ main
                                  │
feat/protocol-codec ──rebase──────▶ merge ──▶ main
                                                 │
feat/cli-resume     ──rebase─────────────────────▶ merge ──▶ main
```

A downstream branch must rebase onto the updated main (which now contains the upstream
branch's changes) and re-run tests before merging.

### 7.3 Squash commit messages

Each branch squashes to **one** commit. Follow the format in
[worktree.md §5](worktree.md#5-squash-and-merge-into-main). Even when multiple agents
work in parallel, the main-branch history reads as one commit per independent feature —
the internal collaboration detail stays in the PR, not in `git log`.

---

## 8. Conflict handling

### Type 1: File-level conflicts (same file modified by two branches)

This means the decomposition step missed an overlap. Do not force-merge; instead:

1. Read both PRs to understand the intent of each change.
2. Pick one branch as the canonical version and manually port the other branch's changes into it.
3. Abandon the other branch and clean up its worktree.

### Type 2: Logical conflicts (code merges cleanly but behavior breaks)

After all branches land in main, run the **full** integration suite:

```sh
# from the main checkout
bun run test
```

Any newly failing test is an integration conflict. "Each agent's tests were green in
isolation" is not a substitute for this step.

---

## 9. Cleanup

Remove each worktree immediately after its branch is merged. Don't let stale worktrees
accumulate:

```sh
# run from the main checkout
git worktree remove ../monad-<feature>
git branch -d feat/<feature>
git push origin --delete feat/<feature>   # if the branch was pushed
```

Periodically clean up dangling references:

```sh
git worktree prune
git fetch --prune
```

---

## 10. Common pitfalls

| Pitfall | Symptom | Fix |
|---|---|---|
| Two agents touch the same file | Merge conflict / mutual overwrite | Draw the file-ownership map before launching |
| Branch drifts without rebasing | Large conflict surface, cascading type errors | Rebase onto main every half-day |
| Copying `.env.local` between worktrees | Port collisions, daemons interfere | Each worktree runs its own `bun run dev` |
| Creating a worktree inside another worktree | Broken `.git` paths | Always create worktrees from the main checkout |
| Branching off main and coding directly there | Unintended changes in the main checkout, port collisions | Always create a worktree first; do all development inside it |
| Vague agent task boundary | Duplicated or missing work | Launch prompt must include explicit "do not touch" list |
| Launching a downstream agent before its upstream is done | Compile errors, flaky tests | TASKS.md marks it blocked; orchestrator unlocks it |
| Merging in the wrong order | Downstream work overwritten by upstream | Enforce the dependency-ordered merge sequence |

---

## Quick reference: end-to-end parallel flow

```
1.  Draw a file-ownership map — confirm no overlaps
2.  Write TASKS.md — record dependencies and block downstream tasks
3.  Create one worktree + branch per task (never branch off the main checkout directly)
      git worktree add ../monad-<feat> -b feat/<feat>
4.  Initialize each worktree
      bun install && bun run dev
5.  Launch each agent in its own terminal with a clear task boundary and success criteria
6.  Rebase every half-day
      git fetch origin && git rebase origin/main
7.  When an agent finishes, push and open a PR
      git push -u origin feat/<feat>
8.  Squash-merge in dependency order
9.  Downstream branches rebase onto the updated main and continue
10. After all branches land, run the full integration suite
      bun run test
11. Clean up worktrees and branches
      git worktree remove ../monad-<feat> && git branch -d feat/<feat>
```
