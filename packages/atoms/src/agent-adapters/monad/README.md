# Monad agent adapter

## Contract map

| Contract surface | Implementation and native bridge |
| --- | --- |
| Identity and detection | Provider `monad`; resolves `monad`; advertises no external auth, structured resume, provider-owned events, hosted agents, and approval proxying. |
| Execution/settings | Autopilot is supported by the native runtime contract; fast mode is not. No adapter-specific settings UI or unsafe CLI argument is registered. |
| Authentication | No provider login is required. Launch/status use `monad --version`; parsing always returns authenticated. |
| Models and arguments | Model selection belongs to the discovered Monad agent, so the adapter returns no global model catalog and exposes no argument-support probe. |
| Settings import / ACP delivery | Not implemented. |
| Hosted agents | Runs `monad app-server --list-agents`, validates the JSON response, and stores the selected native `agentId` in adapter settings. |
| Managed runtime | Declares use of Monad's managed MCP bridge; the app-server receives the managed MCP server and immutable instructions in `session/open`. |
| Session runtime | Resident `monad app-server` child-stdio protocol. `MonadSessionEventDriver` opens the selected agent/session and maps turns, events, interrupt, approval, continuation, and reopen. |
| Runtime controls | Supports provider-owned control through the Monad app-server driver, including approval proxying and structured resume. |
| Events and observation | History resolves the session with `monad session show --json`, reopens it through app-server, and captures `session/event` notifications for projection. |
| Usage | Neither per-session `sessionUsage` nor account-level `usage()` is implemented. |
| Environment/observation helpers | Uses shared defaults. |

## Session lifecycle contract

| Operation | Status | Native command |
| --- | --- | --- |
| Delete | Implemented | `monad session rm <id>` |
| Archive | Implemented | `monad session archive <id>` |
| Unarchive | Implemented | `monad session unarchive <id>` |

## Native bridge

[`lifecycle.ts`](./lifecycle.ts) invokes the configured Monad executable with the mesh session's
`providerSessionRef`, working directory, configured arguments, and resolved environment.

The CLI commands bridge to the daemon's canonical session HTTP contract:

- `session rm` calls `DELETE /v1/sessions/:id`;
- `session archive` calls `PATCH /v1/sessions/:id` with `{ "archived": true }`; and
- `session unarchive` calls the same endpoint with `{ "archived": false }`.

Each non-zero child exit fails the provider lifecycle operation. The adapter does not open Monad's
SQLite store directly, so daemon runtime teardown, undo grace, hooks, and owned-data cleanup stay on the
normal session-handler path.

## Implementation references

- [Session CLI commands](../../../../../apps/cli/src/commands/session/index.ts)
- [Session lifecycle handlers](../../../../../apps/monad/src/handlers/session/handlers/lifecycle/index.ts)
