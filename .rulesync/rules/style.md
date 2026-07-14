---
targets: ["*"]
description: "Code style and typing/contract rules"
globs: ["**/*"]
---

# Code style

Full rules: `docs/engineering/conventions.md` / @docs/engineering/conventions.md.

- Write no comments by default. Add one only for a non-obvious invariant,
  hidden constraint, or counter-intuitive decision.
- Split touched files past roughly 300-400 lines along responsibility boundaries;
  use self-descriptive folders and filenames instead of oversized catch-all files.
- Extract shared logic when the second copy appears; name it for behavior, not origin.
- Use `Promise.all` when awaits have no data dependency.
- No new feature env vars: user settings belong in `config.json`, daemon modes in argv.

# Types and contracts

Typing rules: `docs/engineering/conventions.md` / @docs/engineering/conventions.md.

- Single source of truth: one producer per type; consumers import and derive (`.pick()/.omit()/.extend()`, `Pick/Omit/&`), never redeclare.
- Data-layer types live with their producer: `@monad/protocol` for wire/domain,
  `@monad/home` for config and home layout, daemon store modules for DB rows.
- UI-only props, form state, and view-models stay in the UI app/package.
- Schema-first at runtime boundaries (HTTP/WS/disk): the zod schema is the definition;
  always `parse`, never cast external data.
- In-process-only types stay pure TS until they gain a wire boundary.
- Naming: `xxxSchema` + same-stem PascalCase type; when fields travel in path params, the full request schema is the truth and the body derives via `.omit()`.
