# Agent adapters

This directory contains the built-in implementations of the
[`MeshAgentProviderAdapter`](../../../sdk-atom/src/agent-adapter.ts) contract. Every adapter owns the
translation between Monad's provider-neutral concepts and one provider's native CLI, SDK, app-server,
Gateway, persisted event format, and lifecycle operations.

## Contract coverage

| Adapter | Runtime bridge | Models | History/events | Usage | Settings import | Hosted agents | ACP delivery | Approval proxy | Archive pair |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [Antigravity](./antigravity/README.md) | Per-turn stream JSON | `agy models` | Stream projection | No | No | No | No | No | No |
| [Claude Code](./claude-code/README.md) | Resident SDK stream JSON | Agent SDK | SDK pages + JSONL fallback | SDK messages | Yes | No | Yes | No | No (headless surface gap) |
| [Codex](./codex/README.md) | Resident app-server | `debug models --bundled` | `thread/turns/list` | Token-usage notification | Yes | No | Yes | Yes | Yes |
| [Gemini CLI](./gemini/README.md) | Resident ACP | ACP session catalog | JSON/JSONL history | Persisted token records | Yes | No | No | Yes | No |
| [Hermes Agent](./hermes/README.md) | Resident Dashboard WebSocket | Configured list | Dashboard/CLI/SQLite page reader | No | Yes | Profiles | No | Yes | No |
| [Monad](./monad/README.md) | Resident Monad app-server | Agent-owned | App-server replay | No | No | Monad agents | No | Yes | Yes |
| [OpenClaw](./openclaw/README.md) | Resident Gateway WebSocket | Configured fallback | Session JSONL pages | No | Yes | OpenClaw agents | No | Yes | Yes |
| [Qwen Code](./qwen/README.md) | Resident SDK stream JSON | Config + fallback | JSON/JSONL history | Persisted token records | Yes | No | No | Yes | Yes |

All eight adapters additionally implement identity metadata, binary detection, command resolution,
authentication launch/status parsing, a provider event projector, a managed-runtime definition, and
mandatory exact-session deletion. The provider READMEs document every required and optional field,
including deliberately absent hooks.

No built-in adapter currently implements the account-level `usage()` probe, a custom top-level
`environment` stripping policy, or `observationRuntime`; the daemon's shared defaults apply. This is
distinct from the per-session `sessionUsage` readers implemented by Claude Code, Codex, Gemini, and
Qwen.

## Lifecycle rules

`deleteSession` is required. `archiveSession` and `unarchiveSession` are optional, but an adapter exposes
them only as a pair and only when the provider has an exact, reversible, non-interactive session
operation. `providerSessionRef` is always the provider-owned identity; broad retention commands,
UI-only actions, and guessed private formats do not satisfy the contract.

The `gateway/` directory is shared transport infrastructure used by provider adapters; it is not
itself a registered provider adapter and therefore does not own a separate lifecycle contract.

## Host semantics

- For a running provider gateway that exposes lifecycle controls, archive/delete is sent before the
  runtime is stopped. OpenClaw uses this path so its live Gateway owns the mutation.
- Other mutations run through the provider adapter after the runtime is joined.
- A provider failure is propagated. Monad does not commit the local archive flag or hard-delete the
  local session when the provider mutation fails.
- Unimplemented archive/unarchive hooks mean that Monad changes only its own archive flag for that
  provider. Delete is never optional.

See the daemon orchestration in
[`MeshAgentHost`](../../../../apps/monad/src/services/mesh-agent/host/index.ts) and the local commit order
in the [session lifecycle handlers](../../../../apps/monad/src/handlers/session/handlers/lifecycle/index.ts).
