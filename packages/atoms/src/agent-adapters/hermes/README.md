# Hermes Agent adapter

## Contract map

| Contract surface | Implementation and native bridge |
| --- | --- |
| Identity and detection | Provider `hermes`; resolves `hermes`; advertises provider-owned events, PTY resume/auth, hosted agents, settings import, and approval proxying. |
| Execution/settings | Gateway factory exposes shared settings. Autopilot uses Hermes `--yolo`; fast mode is not supported. |
| Authentication | Login uses `hermes auth`; status uses plain-text `hermes auth list` because that command does not accept `--json`. |
| Models | No native catalog is bridged; `listSupportedModels` returns operator-configured options or an empty fallback. |
| Argument support | Runs `hermes --help` and parses flags, efforts, and speeds; unsafe-argument detection recognizes `--yolo`. |
| Settings import | Imports Hermes framework settings through the shared framework migration. |
| Hosted agents | Runs `hermes profile list` and maps profiles to isolated `HERMES_HOME` values. |
| ACP delivery | Not implemented. |
| Managed runtime | Mirrors the provider config home, persists the managed MCP server in `config.yaml`, writes immutable instructions with `hermes config set agent.system_prompt`, and redirects `HERMES_HOME`. |
| Session runtime | Resident `hermes serve --isolated --skip-build` process with a loopback Dashboard WebSocket at `/api/ws`; the Gateway driver owns turns, interrupts, approvals, resume, and reconnect. |
| Runtime controls | Supports input, steering, interrupt, approval resolution, continuation, restoration, and reopen. |
| Events and observation | History prefers Dashboard `/api/sessions/:id/messages`, then CLI export/SQLite-compatible fallbacks; exposes exact raw pages and projected convenience pages. |
| Usage | Neither per-session `sessionUsage` nor account-level `usage()` is implemented. |
| Environment/observation helpers | Uses shared defaults. |

## Session lifecycle contract

| Operation | Status | Implementation |
| --- | --- | --- |
| Delete | Implemented | `hermes sessions delete <id> --yes` |
| Archive | Not exposed | Available provider surfaces do not offer an exact stable headless pair |
| Unarchive | Not exposed | No corresponding CLI restore command |

## Native bridge

[`lifecycle.ts`](./lifecycle.ts) invokes the configured Hermes executable as:

```text
hermes [configured args] sessions delete <providerSessionRef> --yes
```

`--yes` makes the provider-owned deletion non-interactive. A non-zero exit fails the Monad lifecycle
operation; the adapter never edits Hermes's `~/.hermes/state.db` directly.

Hermes has archive concepts in newer UI/dashboard and storage surfaces, and some versions offer bulk or
filter-based archive maintenance. The CLI contract verified for this adapter does not provide both an
exact `archive <session-id>` command and a matching exact `unarchive <session-id>` command. Exposing only
one direction, calling a bulk command, or binding to an internal database method would violate Monad's
optional reversible contract, so neither hook is registered.

## Provider reference

- [Hermes Agent sessions](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md)
