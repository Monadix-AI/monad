---
root: true
targets: ["*"]
description: "Monad agent instructions — conventions for all coding agents"
globs: ["**/*"]
---

# Agent instructions

Conventions for working in this repo. These apply to **all** coding agents (Claude
Code, Cursor, Copilot, Gemini, ...). Keep this short and imperative; depth lives in
`docs/` and is referenced here.

> **Single source of truth:** this content lives in `.rulesync/rules/` and is
> compiled by [rulesync](https://github.com/dyoshikawa/rulesync) into `AGENTS.md`,
> `CLAUDE.md`, and other agent files. **Edit `.rulesync/rules/`, never generated
> agent files**, then run `bun run agents:sync`.

Rule files in this set:

- `bun.md` — Bun-only runtime + Bun-native frontend rules
- `style.md` — code style + typing/contract rules
- `architecture.md` — package boundaries + per-area responsibilities
- `quality.md` — product principles, security posture, performance budgets
- `workflow.md` — worktree dev environment + testing

## Reference docs
@docs/engineering/conventions.md
@docs/engineering/architecture.md
@docs/engineering/design-principles.md
@docs/engineering/security-guidelines.md
@docs/engineering/cli-design.md
@docs/engineering/performance-guidelines.md
@docs/internals/runtime.md
@docs/internals/realtime-channels.md
@docs/internals/channel-conformance.md
@docs/usage/skills.md
@docs/internals/model-providers.md
@docs/design/ui-guidelines.md
@docs/design/ux-guidelines.md
@docs/design/ux-writing-guidelines.md
@docs/engineering/worktree.md
@docs/engineering/parallel-agents.md
@docs/engineering/testing.md

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tools** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them. `codegraph_node` returns one symbol's source + callers, or reads a whole file with line numbers. If the tools are listed but deferred, load them by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` and `codegraph node <symbol-or-file>` print the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
