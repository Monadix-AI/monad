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

- When running lint, typecheck, and tests as a quality gate, prefer one
  failure-collection pass that exposes all current errors before fixing them. Do not
  bounce between a single failing command and a single fix when the broader failure
  surface is available.
- In unit and integration tests, avoid assertions whose only claim is that a value
  exists, does not exist, or that static copy contains or omits fixed text. Prefer
  behavior, structure, state transitions, and exact machine contracts. E2E tests may
  assert visible copy.
- Every `apps/monad` feature must be exercised over **all transports** (TCP
  loopback and the Unix socket) — behaviour must match on both. See
  `docs/internals/runtime.md` / @docs/internals/runtime.md.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```
