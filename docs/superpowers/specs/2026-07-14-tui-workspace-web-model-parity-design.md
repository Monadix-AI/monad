# TUI Workspace Web-Model Parity Design

## Goal

Align the TUI Workspace's functional Chat and Project behavior with the Web UI while retaining a keyboard-first terminal presentation and keeping Experience extensions Web-only.

## Product Model

### Chat

A Chat is a standalone session with an optional primary Monad Agent binding. New Chat creation lists `Default Agent` plus available Monad Agents:

- Choosing `Default Agent` omits `agentId`; the daemon resolves its configured default.
- Choosing an Agent sends that `agentId` in the existing `CreateSessionRequest`.
- Existing Chats show their bound Agent name when `session.agentIds[0]` exists and otherwise show `Default Agent`.
- Agent deletion or stale IDs degrade to an `Unavailable Agent` label without blocking the Chat.

### Workplace Project

A Workplace Project is a persistent container with project-level member templates and zero or more text sessions. It is not a Chat with a per-session Agent selector.

- Project creation accepts a required name and optional cwd, matching Web `NewProjectDialog`.
- Project management supports rename, cwd update/clear, archive/unarchive, and two-step delete confirmation.
- Project sessions support create, open, rename, and two-step delete confirmation.
- New project sessions use the existing `CreateProjectSessionRequest`; they inherit Project member templates through the daemon and do not receive an `agentId`.

### Project Members

The TUI reads and updates `WorkplaceProject.memberTemplates`, matching Web's project settings model:

- Native actions: list, add, and remove Monad, ACP, and External Agent templates.
- Duplicate Monad/ACP members are rejected using the same type-plus-name identity rule as Web; multiple External Agent instances remain allowed and receive stable instance IDs/display names through shared protocol helpers.
- New sessions inherit the templates; existing sessions retain their own live member bindings.
- Advanced member settings such as sandbox, transport, reasoning, speed, and custom prompt render as a summary with a Web deep link. TUI does not recreate complex editors.

## TUI Interaction Structure

`SessionBrowser` and `ProjectBrowser` use explicit internal modes rather than overloading list keys:

- List mode preserves arrows/j/k, Enter, search, refresh, and Esc.
- `n` opens a focus-trapped creation flow.
- Chat creation first selects `Default Agent` or an Agent, then creates and opens the session.
- Project creation edits name and cwd; project detail exposes sessions, properties, members, and destructive actions.
- Rename/cwd forms use Enter to submit and Esc to cancel.
- Delete always requires opening details and a second confirmation; a single click or keypress cannot delete.
- Every mouse action maps to the same semantic action as a keyboard operation.

Business state for these flows is implemented as small pure reducer models so navigation, validation, and confirmation behavior are unit-testable without mounting Ink.

## Message Row Layout

The speaker and caret occupy a fixed, non-shrinking column. Message content occupies a separate `flexGrow=1`, `flexBasis=0`, shrinkable box and wraps only inside that box. Long content therefore cannot truncate or squeeze the speaker label. Tool rows align to the content column through the same shared speaker-width constant.

The current transcript stores only `user` or `assistant`, so assistant rows keep the current localized `monad` speaker label. Agent selection is displayed in Chat metadata; changing transcript attribution to per-message agents is outside this change because the current TUI message store does not retain canonical `agentName` after settle.

## Data and API Boundaries

The implementation reuses existing `@monad/client-rtk` hooks:

- Agents: list Agents and read the configured default.
- Chats: create, list, update, and delete sessions.
- Projects: create, list, get, update, and delete Workplace Projects.
- Project sessions: create, list, update, and delete sessions.

No daemon endpoint, wire schema, or `@monad/protocol` type changes are required. Shared protocol helpers are reused for member template IDs and default settings. UI navigation state stays inside the TUI.

## Failure Handling

- Mutation failures keep the active form/detail state and show a safe status message.
- Empty names are rejected locally; cwd validation remains authoritative in the daemon and its error is displayed.
- Missing Agents, Projects, or sessions refresh the relevant list and return focus to the nearest surviving row.
- Delete confirmation is cleared whenever selection or route changes.
- If opening the Web settings deep link fails, the TUI displays a copyable URL.

## Testing

- Long message content never reduces the reserved speaker column width.
- New Chat creation omits `agentId` for Default Agent and includes it for an explicit Agent.
- Stale Agent IDs render as unavailable without blocking session open.
- Project creation maps name/cwd to the existing request and rejects a blank name.
- Project updates cover rename, cwd clear, and archive/unarchive.
- Project and project-session deletion require a second confirmation transition.
- Project session creation never adds a per-session `agentId`.
- Member add/remove honors duplicate rules and preserves advanced settings not edited by TUI.
- TUI unit tests, typecheck, Biome, and focused diff checks pass.

## Non-goals

- Experience loading, Web Components, or custom Experience rendering.
- Adding `agentId` to `CreateProjectSessionRequest`.
- Rebuilding advanced graphical Project member settings in Ink.
- Changing daemon lifecycle, persistence, or member-inheritance behavior.
- Persisting per-message Agent attribution in the TUI transcript store.
