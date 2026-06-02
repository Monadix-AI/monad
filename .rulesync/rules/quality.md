---
targets: ["*"]
description: "Product principles, security posture, and performance budgets"
globs: ["**/*"]
---

# Product principles

Design each feature for both cross-platform parity and security-first containment.
Full rules: `docs/internal/development/design-principles.md` / @docs/internal/development/design-principles.md and
`docs/internal/development/security-guidelines.md` / @docs/internal/development/security-guidelines.md.

- Push platform-specific behavior behind a thin uniform interface; do not scatter
  `process.platform` branches through feature code.
- Treat all agent-reachable input as hostile: prompts, tool args, atom packs, MCP,
  skills, channel payloads, and persisted state.
- Keep CLI surfaces scriptable by default: canonical command names, `--json`, stdin
  `-`, stable exit codes, and XDG paths. CLI rules: `docs/internal/development/cli-design.md` /
  @docs/internal/development/cli-design.md.

# Performance

Rules, budgets, and profiling procedure: `docs/internal/development/performance-guidelines.md` /
@docs/internal/development/performance-guidelines.md.

- Measure before you change — no optimization lands without a before/after number.
- Backend hot path (per-token stream, SQLite, request handlers) stays allocation-free, `parse`s at the edge only, prepares statements once, and bounds everything that grows.
- Frontend hot path (transcript re-render per streamed token) stays under one frame — memoize messages, parse markdown incrementally, select narrowly from Redux, virtualize long lists.
