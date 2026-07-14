# Terminal UI

Run `monad tui` for a keyboard-first client backed by the same daemon APIs as the web UI. The TUI keeps the Web product map—Workspace, Studio, and Settings—but intentionally degrades interfaces that need diagrams, visual editors, or browser-only flows.

## Workspace scope

Workspace supports standalone chats, project sessions, Inbox mentions and approvals, and read-only external-agent process projection. It is a text-chat surface: it does not discover, load, or render Experience extensions, Web Components, or custom Experiences.

The projection consumes daemon-normalized live observation frames and history pages. It never parses provider-specific output and cannot send input to an external agent.

## Layout

- 120 columns or wider: navigation and content, with an optional projection pane.
- 80–119 columns: collapsible navigation and content. Press `[` to toggle the sidebar.
- 60–79 columns: single-column route stack; use the command palette to navigate.
- Smaller than 60×18: resize prompt; only help and exit remain available.

Every navigation item is marked `native`, `summary`, or `web-only`. Summary and web-only screens explain the limitation and can open the matching web route; if opening fails, the URL remains visible and copyable.

## Keyboard

| Keys | Action |
|---|---|
| `Ctrl+K` | Command palette |
| `Ctrl+,` | Settings |
| ``Ctrl+` `` | Workspace chat |
| `Ctrl+1`…`Ctrl+9` | Select a section in the current navigation group |
| `Tab` / `Shift+Tab` | Move focus forward / backward |
| `?` | Help |
| `Esc` | Close or go back |
| Arrows or `j` / `k` | Move in a focused list |
| `Enter` | Open, activate, or send |
| `/` | Search the focused chat list |
| `PageUp` / `PageDown` | Scroll transcript; load older projection while it is focused |
| `Shift+Enter` or `Ctrl+J` | Insert a composer newline |
| `Ctrl+C` | Stop the active run; when idle, press twice to exit |

Submitting while a run is active queues a follow-up. `Ctrl+Enter` steers instead: it stops the run, combines queued text with the composer, and starts the replacement turn.

Approvals always open a detail view. Approve and reject require a second `Enter`; rejection can include an optional reason. A click never submits an approval.

## Mouse

Click focuses or activates, the wheel scrolls the region under the pointer, and the wide sidebar can be dragged. Status-bar actions open help or commands. Hold Shift to preserve the terminal's native text selection. Every mouse action has a keyboard equivalent.
