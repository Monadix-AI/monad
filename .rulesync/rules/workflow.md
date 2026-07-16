---
targets: ["*"]
description: "Worktree dev environment and testing workflow"
globs: ["**/*"]
---

# Dev environment

Default workflow: never develop in the main checkout. Every feature, including
single-file fixes, should happen in a dedicated git worktree unless the user explicitly
asks to work on main. Full procedure: `docs/engineering/worktree.md` / @docs/engineering/worktree.md.

```sh
# from the main checkout
git worktree add ../monad-<feature> -b feat/<feature>
cd ../monad-<feature>
bun install && bun run dev
```

`bun run dev` is safe in multiple worktrees; ports are assigned per worktree. When
driving multiple agents in parallel, read `docs/engineering/parallel-agents.md` /
@docs/engineering/parallel-agents.md first.

# Testing

Use `bun run test` for the full suite. When targeting a package, directory, or
file, use `scripts/bun-test.ts ... --only-failures` so only failing case details
are printed. Full testing conventions and patterns: `docs/engineering/testing.md` /
@docs/engineering/testing.md.

- Agents must not use `:loud` scripts or pass `--loud`. Keep test output focused on
  failures; when diagnosing a failure, narrow the package, directory, file, or test
  name and continue using the default quiet entry point or `--only-failures`.
- Run each applicable lint, typecheck, or test scope once to completion and collect all
  failures before editing. Fix the collected failures as one batch, then rerun the same
  complete scope once to verify the batch. Do not alternate between fixing one failure
  and rerunning the command when the script can report the full failure set in one pass.
- Every new or modified test case must avoid weak assertions whose only claim is that
  something exists or does not exist. Litmus test per assertion: if it flipped, what
  user-visible bug would it catch? No answer → delete or rewrite. Rewrite patterns:
  added field/feature → `toEqual` on the full exact contract shape (subsumes existence);
  removed field → typecheck + strict schema parse + updated `toEqual` shapes, never a
  standalone "is gone" case; new UI element → fire the interaction and assert its effect,
  never `getBy* … toBeInTheDocument` (getBy already throws). Presence or absence is valid
  only when it is itself the business contract (deletion, redaction, not-found) — then
  assert it exactly and waive the gate with `// presence-ok: <reason>`. Enforced by
  `bun run check:test-assertions` in `quality:check`; full table in
  `docs/engineering/testing.md` / @docs/engineering/testing.md.
- Every `apps/monad` feature must be exercised over **all transports** (TCP
  loopback and the Unix socket) — behaviour must match on both. See
  `docs/internals/runtime.md` / @docs/internals/runtime.md.

# Merge gate and cleanup

Before merging any branch into `main`:

- Rebase or otherwise update the branch against current `main`, then run `bun run lint`,
  `bun run typecheck`, and `bun run test`; all three must pass.
- Audit the diff for weak assertions in every new or modified test case.
- Put every user-facing string in the i18n catalog and use the repository's i18n APIs;
  do not merge hard-coded UI, CLI, TUI, daemon, channel, notification, accessibility,
  or interaction copy.
- Review UI and UX copy against `docs/design/ux-writing-guidelines.md` and the relevant
  UI/UX guidelines. Fix non-conforming copy before merging.

After merging, update the `main` checkout and run the same lint, typecheck, and test
quality gate again. Do not report completion or clean up the task until all three pass
on merged `main`. Then enumerate every worktree and local or remote branch used for the
task, confirm each is merged into `main`, and remove it. Never delete an unmerged branch
or a worktree that contains work intended to be kept.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```
