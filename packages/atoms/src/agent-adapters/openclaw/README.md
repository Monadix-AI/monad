# OpenClaw agent adapter

## Contract map

| Contract surface | Implementation and native bridge |
| --- | --- |
| Identity and detection | Provider `openclaw`; resolves `openclaw`; advertises provider-owned events, PTY resume/auth, hosted agents, settings import, and approval proxying. |
| Execution/settings | Exposes shared settings. Fast mode is absent. Autopilot is deliberately not advertised because OpenClaw has no safe credential-preserving CLI/env approval-bypass bridge. |
| Authentication | Login uses `openclaw models auth login`; status uses `openclaw models status --check` with provider-specific exit/output parsing. |
| Models | OpenClaw has no models-list command; returns operator-configured values or the `openclaw-default` fallback. |
| Argument support | Runs `openclaw --help` and parses flags, efforts, and speeds. No unsafe skip-approval argument is registered. |
| Settings import | Imports OpenClaw framework settings through the shared framework migration. |
| Hosted agents | Runs `openclaw agents list --json` and maps provider agent IDs into adapter settings. |
| ACP delivery | Not implemented. |
| Managed runtime | Copies provider config, writes immutable `AGENTS.md`, persists the managed MCP server with `openclaw mcp set`, and selects the managed config via `OPENCLAW_CONFIG_PATH` without relocating credentials. |
| Session runtime | Resident `openclaw gateway run --allow-unconfigured` process over an authenticated loopback WebSocket using OpenClaw request/response/event envelopes and signed device identity. |
| Runtime controls | Supports input, steering, interrupt, approval responses, continuation, restoration, reopen, and live lifecycle mutations. |
| Events and observation | Projects live Gateway events. Settled history resolves the exact agent/session through `sessions.json` and reads its JSONL transcript with bounded raw/convenience pagination. |
| Usage | Neither per-session `sessionUsage` nor account-level `usage()` is implemented. |
| Environment/observation helpers | Uses shared defaults. |

## Session lifecycle contract

| Operation | Status | Native Gateway method |
| --- | --- | --- |
| Delete | Implemented | `sessions.patch`, then `sessions.delete` |
| Archive | Implemented | `sessions.patch` with `archived: true` |
| Unarchive | Implemented | `sessions.patch` with `archived: false` |

## Native bridge

OpenClaw has two bridge paths with the same provider semantics.

For a running managed Gateway, [`gateway/index.ts`](./gateway/index.ts) sends OpenClaw request envelopes
over the authenticated WebSocket connection. The shared runtime control waits for the corresponding
Gateway response before Monad stops the process. The connection already has the provider-required
`operator.write` scope.

For a stopped session or an external Gateway, [`lifecycle.ts`](./lifecycle.ts) invokes:

```text
openclaw [configured args] gateway call --json --params <json> <method>
```

Archive and unarchive call `sessions.patch` with the exact provider session key. Delete first archives
that key, then calls:

```json
{"key":"<providerSessionRef>","archivedOnly":true,"deleteTranscript":true}
```

The archive-first sequence matches OpenClaw's generation-safe delete model. `archivedOnly: true` prevents
an active replacement from being removed, while `deleteTranscript: true` requests hard transcript
deletion. The adapter never edits OpenClaw's session store directly.

## Provider reference

- [OpenClaw session tools](https://docs.openclaw.ai/concepts/session-tool)
