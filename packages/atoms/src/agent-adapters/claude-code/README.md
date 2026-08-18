# Claude Code agent adapter

## Contract map

| Contract surface | Implementation and native bridge |
| --- | --- |
| Identity and detection | Provider `claude-code`; resolves `claude` from `PATH`; advertises paged events, PTY auth/resume, settings import, and provider-owned approvals. |
| Execution/settings | Supports autopilot and fast mode. Recognizes both dangerous skip-permission flags and adds a `showThinkingSummary` switch to the shared settings. |
| Authentication | PTY launch uses `claude auth login`; status uses `claude auth status --json`, with structured output and exit-code fallback parsing. |
| Models | Uses `@anthropic-ai/claude-agent-sdk` `supportedModels()` with a timeout; falls back to the adapter's known aliases for display before probing. |
| Argument support | Runs `claude --help` and parses flags, efforts, and speeds. |
| Settings import | Imports Claude Code settings through the provider-specific settings migration. |
| Hosted agents | Not implemented. |
| ACP delivery | Provides the pinned `@agentclientprotocol/claude-agent-acp@0.49.0` wrapper, Claude credential directory, and `ANTHROPIC_API_KEY` recovery metadata. |
| Managed runtime | Passes Monad's managed MCP server through Claude MCP config arguments and marks the MCP bridge as required. |
| Session runtime | Resident child-stdio stream-JSON driver. Launch maps model, effort/ultracode, fast mode, system prompt file, extra directories, MCP config, thinking display, and `--resume <id>`. |
| Runtime controls | Supports input, steering, interrupt, continuation, restoration, and reopen. Provider approval resolution is not exposed by this driver. |
| Events and observation | Reads paged history with Agent SDK `getSessionMessages`; falls back to exact local JSONL transcripts; projects live SDK stream messages into Monad events. |
| Usage | Aggregates unique assistant-message usage from Agent SDK history, including cache tokens and known context windows. Account-level `usage()` is absent. |
| Environment/observation helpers | Uses shared defaults. |

## Session lifecycle contract

| Operation | Status | Implementation |
| --- | --- | --- |
| Delete | Implemented | Best-effort CLI cleanup followed by exact local-session removal |
| Archive | Provider-supported, adapter not exposed | Claude Code Desktop and Web implement archive, but the headless CLI/Agent SDK boundary used by this adapter does not export it |
| Unarchive | Provider-supported, adapter not exposed | Claude Code's native remote-session client implements unarchive, but the headless CLI/Agent SDK boundary used by this adapter does not export it |

## Native bridge

[`lifecycle.ts`](./lifecycle.ts) first invokes the configured executable as:

```text
claude [configured args] rm <providerSessionRef>
```

`claude rm` primarily covers Claude-owned background job/worktree state. The exact `No job matching`
diagnostic is tolerated because an ordinary resumable Claude Code session is not necessarily a
background job. Other non-zero results fail the lifecycle operation.

Regular Claude Code CLI sessions are persisted locally, so deletion then resolves the configured
`CLAUDE_CONFIG_DIR` (default `${HOME}/.claude`) and removes only data proven to belong to the exact
session ID:

- JSONL transcripts below `projects/` whose records contain the matching `session_id`;
- the adjacent `projects/<project>/<session-id>/` sidecar directory; and
- exact `<session-id>` or `<session-id>.*` entries under `file-history`, `session-env`, `tasks`, and
  `debug`.

The adapter does not infer a filename from the ID alone: it reads JSONL records and requires an exact
`session_id` match before deleting a transcript.

Claude Code does implement archive and unarchive outside the headless CLI surface used here:

- Claude Code Desktop exposes archive for local Code sessions and persists an `isArchived` lifecycle
  state. Its native archive path also stops the runtime, handles worktree cleanup, and synchronizes
  associated Remote Control sessions; it is not equivalent to changing that field on disk.
- Claude Code on the Web exposes archive in the session sidebar and an archived-session filter.
- Claude Code's first-party remote-session client calls
  `POST /v1/code/sessions/<remote-session-id>/archive` and
  `POST /v1/code/sessions/<remote-session-id>/unarchive`.

The adapter runs ordinary local CLI/Agent SDK sessions and stores the CLI UUID emitted by stream JSON.
The public CLI and `@anthropic-ai/claude-agent-sdk` session-mutation API expose resume, fork, rename,
tag, and delete, but not archive or unarchive. A cloud/Remote Control session ID is a different
identifier and may additionally require OAuth and trusted-device state. Consequently, the adapter
must not send its local `providerSessionRef` to the remote endpoints, edit Desktop's private metadata,
or register hooks that only partially reproduce Desktop's lifecycle. Archive and unarchive remain
absent from the adapter until Anthropic exposes a supported headless mutation for local CLI session
IDs or Monad owns a remote-session identity and authentication bridge.

## Provider references

- [Claude Code session management](https://code.claude.com/docs/en/sessions)
- [Claude Code Desktop session management](https://code.claude.com/docs/en/desktop#manage-sessions)
- [Claude Code on the Web session management](https://code.claude.com/docs/en/claude-code-on-the-web#work-with-sessions)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage)
