# UX design guidelines

> **Placeholder.** Fill this in with interaction principles, user-flow conventions,
> and the review criteria for evaluating new or changed user experiences.

## Areas to cover

- Core interaction model (how users navigate, invoke actions, recover from errors)
- Copy and micro-copy conventions: see [UX writing guidelines](ux-writing-guidelines.md)
- Loading, empty, and error state requirements
- Keyboard and discoverability standards
- User research artefacts that inform these decisions
- Link to user journey maps or prototype source

## Touch interactions

- Functional controls must not depend on hover-only discovery. If a button or action
  group is hidden until its container is hovered or focused, it must be visible by
  default on touch and coarse-pointer devices.
- In `apps/web`, prefer the shared `HoverActions` helpers for hover-revealed action
  groups. If a local class is unavoidable, include the same
  `[@media_(hover:none),_(pointer:coarse)]` fallback so touch users can see and tap
  the controls without first discovering an invisible hit area.

## Internationalisation (i18n)

Monad uses i18next (CLI/daemon) and react-i18next (web). Language packs live in
`packages/atoms/src/locales/` and are loaded as `locale` atom capabilities.

### What to translate

**Translate** everything a human reads directly:

- CLI command output (`out()` calls in `apps/cli/`)
- TUI / daemon console messages
- Web UI labels, placeholders, aria-labels, tooltips
- Channel / bot replies sent to end users (Telegram, etc.)

**Do not translate** values consumed programmatically:

- HTTP / WS API response bodies (error codes, field values)
- Structured log entries
- Stack traces and exception messages
- Internal error strings thrown between modules

The criterion is **"human eye vs. machine"**, not "developer vs. end user" — CLI
users and TUI users are end users too.

### Adding new strings

1. Add the English key + value to `packages/i18n/src/en.json`.
2. Add the Chinese translation to `packages/atoms/src/locales/zh.json` (same key).
3. Use `t('your.key')` at the call site — `useT()` hook in React, module-level `t`
   singleton in CLI, `ctx.t()` injection in daemon handlers.
4. Plurals: use `key_one` / `key_other` suffixes; zh only needs `key_other`.

### Key namespace conventions

| Prefix | Surface |
|--------|---------|
| `web.*` | `apps/web` React components |
| `cli.*` | `apps/cli` command output |
| `cmd.*` | Daemon slash-command replies |
| `channel.*` | Channel / bot messages to users |
