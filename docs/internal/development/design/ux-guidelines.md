---
title: "UX Design Guidelines"
audience: "internal-developer"
description: "Interaction conventions for apps/web and other rendered surfaces. Visual tokens and component rules live in ui-guidelines.md and design-system.md; the exact."
---
Interaction conventions for `apps/web` and other rendered surfaces. Visual tokens and
component rules live in [UI guidelines](ui-guidelines.md) and the public
[design system](../../../design/design-system.md); the exact wording for every state described here
follows [UX writing guidelines](ux-writing-guidelines.md). Product intent, audiences, brand personality, and design principles are in [What Monad is](../../../product.md).

## Core interaction model

`apps/web` is a daemon-control UI: all state lives in the local daemon, and the browser
is one of several clients observing and steering it. Three user groups share this one
surface — everyday agent users, developer power users, and team operators — which sets
the two governing rules:

- **Progressive depth.** The first thing on any screen must be learnable by a
  non-technical user; the full depth (model config, MCP wiring, approval policies, atom
  conflicts) stays reachable but never crowds the primary experience. Default views
  show the simple path; density and configuration live one level down.
- **Agency, clearly surfaced.** When the agent acts or asks for something, the UI makes
  it impossible to miss and easy to understand. Trust comes from clarity about what is
  happening and why.

The three primary flows:

- **Session flow.** The chat transcript is the primary surface. Responses stream in
  live; the transcript shows observable agent activity (tool calls, file edits,
  reasoning markers) as it happens, using the timeline copy rules in
  [UX writing guidelines](ux-writing-guidelines.md). Sessions are long-lived and
  shared across clients — another client or a channel may drive a turn — so the UI
  treats refetched history as canonical and reconciles rather than assuming it saw
  every event first.
- **Approval flow.** A pending approval blocks the agent's turn, so it must interrupt:
  surfaced prominently in the transcript, never as a dismissible toast. The prompt
  states actor, action, target, scope, and consequence exactly (see the approval
  section of [UX writing guidelines](ux-writing-guidelines.md)), and the paired
  actions make the safer choice unambiguous. Approvals may time out and auto-deny;
  the UI must show that outcome, not leave the request dangling.
- **Settings plane.** Settings are the power-user and operator surface: dense rows,
  grouped by domain, tolerant of expert vocabulary — but destructive or
  security-sensitive changes (credentials, remote access, channel policies) still get
  explicit confirmation with named consequences. Casual users should never need to
  visit settings to complete a session.

Recovery is part of the model: the daemon can restart, streams can drop, and other
clients can change state underneath the view. Reconnection is silent when automatic;
when the daemon is genuinely unreachable, say so and name the recovery step.

## Loading, empty, and error states

Every asynchronous surface must design all three states — none may fall through to a
blank region. Copy templates for each live in
[UX writing guidelines](ux-writing-guidelines.md); the interaction requirements:

- **Loading** names the operation in progress. Prefer a layout-stable placeholder
  (skeleton) for content regions so the page does not jump when data arrives; reserve
  spinners for small inline waits. If the app is waiting on another process (daemon,
  model), say which.
- **Empty** states state what is missing and offer the next action directly — a button
  that performs it, not instructions to go elsewhere.
- **Error** states include what failed and a recovery path. Offer `Try again` only when
  retry is safe; keep raw details (stack traces, payloads) behind a details
  disclosure, never in the primary message. A transient failure that the client is
  already retrying (stream reconnect) is a quiet status, not an error dialog.

## Keyboard and discoverability

- Every action reachable by pointer is reachable by keyboard, with a visible focus
  state (see [UI guidelines](ui-guidelines.md) for the focus treatment).
- `Escape` closes the topmost overlay — dialog, popover, menu — without side effects.
  Overlays with unsaved destructive-to-lose input may confirm before discarding.
- Typing `/` in the chat input opens the skill and command menu — the discoverability
  path for invocable capabilities. New invocable features should register there rather
  than inventing a parallel entry point.
- Do not gate any function behind hover-only or gesture-only discovery; whatever a
  hover reveals must also be reachable by focus and visible on touch (next section).

## Touch interactions

- Functional controls must not depend on hover-only discovery. If a button or action
  group is hidden until its container is hovered or focused, it must be visible by
  default on touch and coarse-pointer devices.
- In `apps/web`, prefer the shared `HoverActions` helpers for hover-revealed action
  groups. If a local class is unavoidable, include the same
  `[@media_(hover:none),_(pointer:coarse)]` fallback so touch users can see and tap
  the controls without first discovering an invisible hit area.

## Cursor and selection defaults

- Do not use a hand pointer as the global interaction affordance. Monad follows the
  Settings surface model: buttons, links, tabs, menu items, summaries, rows, and
  other clickable controls should keep the platform/default cursor unless a specific
  interaction requires a different cursor.
- Do not make text globally selectable. Enable selection case by case only where
  copying is part of the expected workflow, such as inputs, code blocks, terminal
  output, logs, transcripts, generated messages, or explicit copy/reference surfaces.
- In `apps/web`, use `.monad-selectable` or `data-selectable="true"` for those
  explicit copy surfaces. Avoid scattering `select-text`, `select-auto`, or custom
  `user-select` rules across ordinary layout, chrome, labels, nav, and cards.
- Cursor exceptions should describe a concrete manipulation state, for example
  resize, drag, disabled/not-allowed, or text insertion. They should not be used
  simply to mark an element as clickable.

## Internationalisation (i18n)

Monad has its own catalog runtime in `@monad/i18n` — no i18next. Built-in message
catalogs live in `packages/i18n/src/locales/<lng>/<namespace>.json`, and additional
language packs are loaded as `locale` atom capabilities (from an atom pack's
`locales/` directory or `~/.monad/atoms/locales/`).

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

1. Add the English key + value to `packages/i18n/src/locales/en/<namespace>.json`
   (`web`, `cli`, `cmd`, `channel`, `daemon`, `init`).
2. Add the Chinese translation to `packages/i18n/src/locales/zh/<namespace>.json`
   (same key).
3. Run `mise run i18n:types` to regenerate `catalog-types.ts` — key names are
   type-checked, so a missing translation fails typecheck rather than shipping.
   `bun run test` and `bun run typecheck` run it for you.
4. Use `t('your.key')` at the call site — the `useT()` hook from
   `apps/web/src/components/I18nProvider.tsx` in React, the module-level `t` singleton
   (`apps/cli/src/lib/i18n.ts`) in the CLI, injected `t` in daemon handlers.
5. Plurals: use `key_one` / `key_other` suffixes; zh only needs `key_other`.

Removing a string is the same steps in reverse. `mise run i18n:prune` reports keys no source
file references and zh keys that no longer exist in en; `mise run i18n:prune:write` deletes
them. The search is a static text scan, so review the report first — a key assembled at runtime
reads as unused.

### Key namespace conventions

| Prefix | Surface |
|--------|---------|
| `web.*` | `apps/web` React components |
| `cli.*` | `apps/cli` command output |
| `cmd.*` | Daemon slash-command replies |
| `channel.*` | Channel / bot messages to users |
