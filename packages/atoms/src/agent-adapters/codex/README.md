# Codex agent adapter

## Contract map

| Contract surface | Implementation and native bridge |
| --- | --- |
| Identity and detection | Provider `codex`; resolves the CLI from `PATH` or the bundled Codex.app binary; advertises structured resume, paged events, settings import, and approval proxying. |
| Execution/settings | Supports autopilot and fast mode; recognizes `--dangerously-bypass-approvals-and-sandbox`; exposes shared settings. |
| Authentication | PTY login uses `codex login`; status uses `codex login status` and structured/exit-code parsing. |
| Models and arguments | Runs `codex debug models --bundled`; one parser builds model options and another derives flags, per-model reasoning efforts, and speed support. |
| Settings import | Imports Codex configuration through the provider-specific settings migration. |
| Hosted agents | Not implemented. |
| ACP delivery | Provides pinned `@agentclientprotocol/codex-acp@1.0.0`, Codex credential directory, and `OPENAI_API_KEY` recovery metadata. |
| Managed runtime | Adds non-interactive environment policy and native Codex MCP configuration arguments; declares the managed MCP bridge. |
| Session runtime | Resident `codex app-server` over child stdio. The driver maps Monad controls to app-server thread/turn requests and provider approval responses. |
| Runtime controls | Supports input, steering, interrupt, approval resolution, provider continuation, restoration, and reopen. |
| Events and observation | Live app-server notifications are projected into Monad events; history pages use experimental `thread/turns/list` with cursors and raw/convenience views. |
| Usage | Resumes the exact thread through app-server and reads `thread/tokenUsage/updated`, including cache, reasoning, and context-window fields. Account-level `usage()` is absent. |
| Environment/observation helpers | Uses shared defaults. |

## Session lifecycle contract

| Operation | Status | Native method |
| --- | --- | --- |
| Delete | Implemented | `thread/delete` |
| Archive | Implemented | `thread/archive` |
| Unarchive | Implemented | `thread/unarchive` |

## Native bridge

[`lifecycle.ts`](./lifecycle.ts) starts the configured Codex executable in app-server mode:

```text
codex [configured args] app-server --stdio
```

It initializes the JSON-RPC connection and sends the selected method with the provider-owned thread ID:

```json
{"threadId":"<providerSessionRef>"}
```

The operation succeeds only after the matching JSON-RPC response is parsed without an `error`. A
malformed response, provider error, or timeout fails the Monad lifecycle operation. The temporary
app-server process is always terminated after the response.

Archive and unarchive use Codex's reversible rollout-directory transition. Delete uses Codex's hard
delete operation, which also covers spawned descendant threads according to the provider contract.

## Provider reference

- [Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
