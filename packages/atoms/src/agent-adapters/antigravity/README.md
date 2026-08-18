# Antigravity agent adapter

## Contract map

| Contract surface | Implementation and native bridge |
| --- | --- |
| Identity and detection | Provider `antigravity`; resolves `agy` from `PATH`; reports PTY auth, provider-owned events/approvals, and structured resume. |
| Execution/settings | Autopilot is supported with `--dangerously-skip-permissions`; fast mode is not. Exposes the shared model/reasoning/autopilot settings. |
| Authentication | Opens `agy models` in a PTY. Status runs the same command and treats a successful, non-empty model catalog as authenticated. |
| Models | `modelOptions` runs `agy models` with a 10-second timeout and parses provider model slugs; `listSupportedModels` uses configured options. |
| Argument support | Runs `agy --help` and parses supported flags, efforts, and speeds. The unsafe-argument hook recognizes `--dangerously-skip-permissions`. |
| Settings import / hosted agents / ACP | Not implemented; Antigravity exposes no adapter-owned import, hosted-agent discovery, or ACP wrapper contract here. |
| Managed runtime | Writes `.agents/mcp_config.json` and a `monad-managed` agent definition containing immutable instructions; declares the managed MCP bridge. |
| Session runtime | Per-turn `agy --print` process with `--output-format stream-json`; adds conversation, model, effort, extra-directory, managed-agent, and approval flags. Continuation uses the provider conversation ID. |
| Runtime controls | No resident steer/interrupt/approval channel; each turn is a provider process and approvals remain provider-owned. |
| Events and observation | Parses Antigravity stream-JSON into provider-neutral events. No separate provider history-page reader is registered. |
| Usage | Neither per-session `sessionUsage` nor account-level `usage()` is implemented. |
| Environment/observation helpers | Uses the daemon's shared environment policy and observation runtime. |

## Session lifecycle contract

| Operation | Status | Implementation |
| --- | --- | --- |
| Delete | Implemented | Exact cleanup of the conversation in Antigravity CLI's local store |
| Archive | Not exposed | No stable headless API for an exact reversible transition |
| Unarchive | Not exposed | No stable headless API for an exact reversible transition |

## Native bridge

Antigravity CLI documents workspace-scoped resume, fork, and interactive conversation deletion, but it
does not publish a non-interactive delete/archive API that accepts a conversation ID. The adapter's
delete implementation therefore owns an explicit local-storage bridge instead of driving the TUI or
guessing an interactive key sequence.

For `providerSessionRef = <id>`, [`lifecycle.ts`](./lifecycle.ts) validates the identifier and updates the
default `${HOME}/.gemini/antigravity-cli` store (or the injected test root):

- stages `conversations/<id>.db`, `.db-shm`, `.db-wal`, and `.pb` for deletion;
- deletes `<id>` from `conversation_summaries.db`;
- removes the exact entry from `cache/conversation_metadata.json`; and
- removes workspace pointers equal to `<id>` from `cache/last_conversations.json`.

The SQLite mutation and cache rewrites are coordinated. If any step fails, the database transaction is
rolled back, original cache contents are restored, and staged conversation files are renamed back.

Archive/unarchive remain unimplemented because doing so would require mutating undocumented protobuf or
annotation state. The existence of an interactive UI action is not treated as a stable native contract.

## Provider references

- [Managing conversations](https://antigravity.google/docs/cli/conversations?authuser=1)
- [Antigravity CLI changelog](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md)
