# Qwen Code agent adapter

## Contract map

| Contract surface | Implementation and native bridge |
| --- | --- |
| Identity and detection | Provider `qwen`; resolves `qwen`; advertises provider-owned events, PTY auth/resume, settings import, and approval proxying. |
| Execution/settings | Supports autopilot through `--approval-mode=yolo`/`--yolo`; fast mode is absent; exposes shared settings. |
| Authentication | Login opens Qwen Code; status uses the read-only `qwen --list-sessions` probe with structured-state parsing when available. |
| Models | Prefers operator-provided options, then parses configured `~/.qwen/settings.json` model providers, then falls back to known Qwen Coder models. No separate `modelOptions` process probe is registered. |
| Argument support | Runs `qwen --help` and parses flags, efforts, and speeds; unsafe-argument detection covers both yolo spellings. |
| Settings import | Imports the `.qwen` settings root through the basic settings migration. |
| Hosted agents / ACP delivery | Not implemented. |
| Managed runtime | Writes an isolated `.qwen/settings.json` containing the trusted managed MCP server and declares the managed MCP bridge. |
| Session runtime | Resident Qwen SDK stream-JSON child-stdio channel. Launch maps resume ID, model, approvals, extra directories, immutable prompt, and input/output formats. |
| Runtime controls | Driver supports input, steering, interrupt, approval responses, continuation, restoration, and reopen over the bidirectional SDK stream. |
| Events and observation | Projects live SDK records and reads exact Qwen JSON/JSONL history beneath `~/.qwen` for raw/convenience event views. |
| Usage | Aggregates persisted assistant `usageMetadata`, including cache, thought tokens, and provider context-window values. Account-level `usage()` is absent. |
| Environment/observation helpers | Uses shared defaults. |

## Session lifecycle contract

| Operation | Status | Native REST route |
| --- | --- | --- |
| Delete | Implemented | `POST /sessions/delete` |
| Archive | Implemented | `POST /sessions/archive` |
| Unarchive | Implemented | `POST /sessions/unarchive` |

## Native bridge

[`lifecycle.ts`](./lifecycle.ts) starts a loopback-only temporary Qwen daemon for the mesh session's
workspace:

```text
qwen [configured args] serve --workspace <workingPath> --hostname 127.0.0.1 --port 0 --no-web
```

After parsing the announced URL, the adapter posts the exact provider session ID:

```json
{"sessionIds":["<providerSessionRef>"]}
```

Requests carry `X-Qwen-Client-Id: monad-provider-lifecycle`. Archive and unarchive first require
`GET /capabilities` to advertise `session_archive`; Monad does not infer support from a version number.

The adapter validates HTTP status, JSON shape, `errors`, and the action-specific success arrays. Delete
accepts `removed` or `notFound` as idempotent success. Archive/unarchive require the ID in the matching
completed/already-completed array and reject conflicts or omissions.

The temporary daemon is stopped in `finally`, escalating from `SIGTERM` to `SIGKILL` only if it does not
exit within five seconds. The adapter does not move Qwen transcript files itself.

## Provider reference

- [Qwen serve protocol](https://github.com/QwenLM/qwen-code/blob/main/docs/developers/qwen-serve-protocol.md)
