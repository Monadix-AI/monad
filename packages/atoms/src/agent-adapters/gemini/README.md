# Gemini CLI agent adapter

## Contract map

| Contract surface | Implementation and native bridge |
| --- | --- |
| Identity and detection | Provider `gemini`; resolves `gemini` from `PATH`; reports PTY auth/resume, provider-owned history, approvals, and settings import. |
| Execution/settings | Supports autopilot through `--approval-mode=yolo`/`--yolo`; fast mode is not supported; exposes shared settings. |
| Authentication | Login opens the provider CLI. Status is a read-only local credential probe covering API keys, selected Google account, and Application Default Credentials. |
| Models | Starts `gemini --acp`, initializes ACP, creates a temporary session, and reads `availableModels`; documented fallback models are used only for auth/quota/catalog-unavailable failures. |
| Argument support | Runs `gemini --help` and parses flags, efforts, and speeds; unsafe-argument detection covers both yolo spellings. |
| Settings import | Imports the `.gemini` settings root through the basic settings migration. |
| Hosted agents / ACP delivery | No hosted-agent discovery or separate ACP wrapper. The native session runtime itself speaks Gemini's built-in ACP mode. |
| Managed runtime | Writes an isolated system-settings file and points `GEMINI_CLI_SYSTEM_SETTINGS_PATH` at it; native ACP receives the managed MCP server. |
| Session runtime | Resident `gemini --acp` child-stdio JSON-RPC driver. It maps `session/new`, `session/load`, `session/prompt`, cancel, and permission requests/responses. |
| Runtime controls | Supports input, interrupt, approval resolution, continuation, restoration, and reopen. ACP does not expose same-turn steering. |
| Events and observation | Projects ACP/live provider records; history scans exact Gemini JSON/JSONL session records and normalizes checkpoint-style records when needed. |
| Usage | Aggregates persisted Gemini token records, including cache, thought tokens, and context estimates. Account-level `usage()` is absent. |
| Environment/observation helpers | Uses shared defaults. |

## Session lifecycle contract

| Operation | Status | Implementation |
| --- | --- | --- |
| Delete | Implemented | `gemini --delete-session <id>` |
| Archive | Not exposed | No documented exact reversible archive API |
| Unarchive | Not exposed | No documented exact reversible archive API |

## Native bridge

[`lifecycle.ts`](./lifecycle.ts) invokes the configured Gemini CLI as:

```text
gemini [configured args] --delete-session <providerSessionRef>
```

The command runs with the mesh session's `workingPath`, because Gemini session history is scoped by the
project root. Gemini accepts either an index or a full session UUID; Monad always supplies the persisted
provider session reference. A non-zero exit fails the lifecycle operation.

Gemini owns removal of the chat and its associated plans, task trackers, tool outputs, and activity logs.
The adapter does not scan or delete `~/.gemini/tmp` directly.

The documented checkpoint, rewind, fork, and resume features are not archive semantics: they do not
provide an exact reversible hidden-state transition for an existing session. Archive/unarchive are
therefore intentionally absent.

## Provider references

- [Gemini CLI session management](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md)
- [Gemini CLI configuration reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md)
