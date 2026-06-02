# ACP — editor integration (Agent Client Protocol)

monad speaks [ACP](https://agentclientprotocol.com) **both ways**:

- **As an agent** — editors (Zed, and others) drive monad as a built-in coding agent: streamed
  responses, reviewable inline diffs, integrated-terminal commands, approval prompts.
- **As a client** — monad can delegate a subtask to *another* ACP agent (codex, claude-code, …) via
  the `agent_acp_delegate` tool (see [Multi-agent delegation](#monad-as-an-acp-client--multi-agent-delegation)).

Built on the official SDK `@agentclientprotocol/sdk@^0.25.1`.

## Architecture — `monad acp` is a thin bridge

`monad acp` does **not** build a daemon in-process. It's a thin **bridge**: the editor spawns it over
stdio, and it proxies the ACP connection to an already-running monad daemon over the local Unix socket
(REST + inline SSE). If no daemon is running, it **auto-spawns** one (detached) and waits for health,
then bridges. The agent loop runs in that shared daemon — so editor sessions appear in the Web UI/TUI
and reuse one store, model config, and ledger.

```
editor ──stdio(ACP)──▶ monad acp (bridge)  ──unix socket(REST+SSE)──▶  daemon
                         │ MonadAcpAgent                                 │ agent.loop runs here
                         │ handlers = RPC proxy (transports/acp/bridge.ts)
                         └ services delegation.* over ACP reverse-RPC ◀─ DelegationService
```

Key files (`apps/monad/src/transports/acp/`): `connection.ts` (`AgentSideConnection` + the
`MonadAcpAgent` adapter), `bridge.ts` (the `AcpHandlers` RPC proxy to the daemon), `launch.ts`
(discover/auto-spawn + bridge), `translate.ts` (pure Event↔ACP), `backends.ts` (editor-facing
fs/terminal backends). The daemon side: `services/delegation.ts` (reverse fs/terminal),
per-session runtime registry + `sessions.configureRuntime` (`modules/session/`).

The bridge dials the **local** Unix socket only, so delegation + session-scoped MCP keep the
"local editor = trust boundary" assumption (a remote daemon is never targeted).

## Running

```
monad acp                          # installed CLI (editor launches this)
bun apps/monad/src/main.ts --acp   # from source
```

stdout is the ACP JSON-RPC channel; **all logs go to stderr**. `--log trace` shows per-call transport
activity on stderr.

### Register in Zed

```json
{
  "agent_servers": {
    "monad": { "type": "custom", "command": "monad", "args": ["acp"] }
  }
}
```

## What's supported

- **Core**: `initialize`, `session/new`, `session/prompt` (streaming `session/update`), `session/cancel`.
- **Sessions**: `session/list`, `session/load` (replays transcript), `session/fork` → monad's branch
  (time-travel), `session/resume` (re-attach without replay), `session/delete`, `session/close`.
- **Permission**: monad's oversight gate bridges to `session/request_permission`.
- **Multimodal**: image content blocks reach the model (transient on the turn's user message).
- **Document sync**: `unstable_did{Open,Change,Close,Focus,Save}Document` — open editor docs are
  tracked per session and folded into the turn as ambient context (utf-16 positions).
- **Commands**: monad's unified command set (built-ins + atom pack commands + user-invocable skills) is advertised
  via `available_commands_update`.
- **Free-text clarify**: via `unstable_createElicitation` (form mode) when the client supports it; else
  the question is surfaced and the turn proceeds.

### Per-session runtime config (`sessions.configureRuntime`)

Because the loop runs in the shared daemon, the editor's per-session settings reach it **out of band**
(runOpts can't cross the wire). On `session/new|load|resume|fork` the bridge calls
`sessions.configureRuntime` to push, for that session:

- **Sandbox roots** — the editor's `cwd` + `additionalDirectories` replace the daemon's default roots
  for this session's fs/shell. Priority at turn time: explicit per-turn roots > configureRuntime roots
  > ephemeral session root (`sandbox` mode `ephemeral`) > the loop's global default.
- **Session-scoped MCP servers** — client-provided MCP servers connect daemon-side; their tools join
  every turn and are released on session close/delete. (Local-daemon only.)
- **Delegation flags** — which capabilities to delegate back to the editor (below).

### Reverse fs/terminal delegation

When the client advertises `fs`/`terminal` capability, monad delegates those ops back to the editor so
edits appear as **reviewable diffs** and commands run in the editor's terminal. Since the loop runs in
the daemon (not in the bridge), this is modelled like oversight/clarify — **an out-of-band event + an
inbound RPC**, not in-process backends:

1. A delegated `fs_write`/shell tool runs in the daemon against a *remote* backend
   (`DelegationService`), which emits a `delegation.fs_request` / `delegation.terminal_request` event.
2. The event rides the turn's stream to the bridge, which services it against the editor
   (`fs/*`, `terminal/*` reverse-RPC) and answers via the `delegation.respond` RPC (streaming terminal
   output via `delegation.output`).

Tools that can't be delegated (`process_*`, `code_execute`, `fs_glob`, `fs_grep`) are dropped from a
delegated session so they can't silently run on the daemon host (`isDelegableTool`).

## monad as an ACP client — multi-agent delegation

The `agent_acp_delegate` tool spawns a **configured external ACP agent** and drives it to carry out a
self-contained subtask, returning its answer. Register agents in `config.json`:

```jsonc
"acpAgents": [
  { "name": "codex",  "command": "codex",  "args": ["acp"] },
  { "name": "claude", "command": "npx", "args": ["@zed-industries/claude-code-acp"],
    "env": { "ANTHROPIC_API_KEY": "${env:ANTHROPIC_API_KEY}" } }
]
```

The model supplies a registered **name**, never a command (no RCE); the tool is high-risk so spawning
is gated by oversight. `env` values support `${env:NAME}` secret-refs (resolved at spawn). monad serves
the sub-agent's **fs + terminal** through its own sandbox (containment) and routes the sub-agent's
permission prompts through the oversight gate; the sub-agent's tool calls + plan surface on the parent
turn's stream. `env` is operator-vetted infrastructure config → it lives in the **system** config
(`config.json`), alongside `mcpServers`.

## monad extensions (`_meta` / extMethod)

Advertised in `initialize` under `_meta.monad.extMethods`:

- `_monad/session.restore` `{ sessionId, toMessageId }` — rewind to a checkpoint.
- `_monad/session.provenance` `{ sessionId }` — ancestors/descendants of a session.
- `_monad/model.{listProviders,listModels,listProfiles,getDefaultProfile,setDefaultProfile}` — pick a
  model through monad's gateway. (Credential mutation is intentionally not exposed over ACP.)

Multi-agent: pass `_meta.monad.agentId` to `session/new` to choose a configured agent; the response
echoes `_meta.monad.agentIds`.

## Known limitations

- Per-session runtime config (sandbox roots / MCP / delegation) is in-memory; a daemon restart drops it
  and the client re-pushes via `configureRuntime` on re-attach (correct for ACP's stateless bridge).
- Delegated terminals don't yet pass through the sub-agent's requested env vars.
- The bridge's auto-spawn path isn't covered by an automated test (spawning a second `bun` trips the
  macOS taskgated code-signature kill — see the bun-exec-blocked note).

## Debugging

`bun scripts/acp-smoke.ts` spawns a real `monad --acp --mock-model` and drives it with the SDK client
(initialize → new → prompt → fork); now it auto-spawns/attaches a daemon. `bun scripts/acp-smoke.ts
--log trace` adds per-call traces. Fastest inner loop:
`bun scripts/bun-test.ts apps/monad/test/e2e/acp-{transport,bridge,delegate}.test.ts --only-failures`.
