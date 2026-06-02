---
title: "MCP Servers"
sidebarTitle: "MCP Servers"
description: "Connect and govern local or remote Model Context Protocol servers and their tools."
keywords: ["MCP", "Model Context Protocol", "MCP server", "tool approval", "pinned tool hash"]
---
MCP (Model Context Protocol) is an open standard that lets an agent call tools served by
an external process or remote service. Monad connects to the MCP servers you configure
and merges their tools into the agent's toolbox: a remote tool appears to the model as
`<server>__<tool>` (for example `github__create_issue`) and behaves like any built-in
tool. MCP tools cross a trust boundary, so they are high-risk by default — every call
routes through the approval gate unless you explicitly auto-approve it (see
[Trust controls](#trust-controls)).

Servers connect at daemon startup. A server that fails to connect is logged and skipped —
it never blocks startup or the other servers.

## Adding a server

### CLI

`monad mcp` is the scriptable surface and needs no restart:

```bash
monad mcp search <query>                      # official registry, Glama, Smithery, built-in catalog
monad mcp add github npx -y @modelcontextprotocol/server-github
monad mcp add linear --url https://mcp.linear.app/mcp
monad mcp list                                # installed servers, every source
monad mcp status                              # live connection health and advertised tools
monad mcp enable|disable|remove <name>
monad mcp authorize|reconnect <name>          # act on agents.json servers (see OAuth below)
```

`mcp add` installs the server as a hot MCP atom under `~/.monad/atoms/mcp/`. A server that
needs authentication or trust controls belongs in `agents.json` instead — see below.

### Web UI

Studio → Capabilities → MCP servers lists every configured server with live status
(connected, disabled, or failed) and its advertised tools, and adds, edits, enables,
authorizes, reconnects, and removes them. It is the same state `monad mcp` reads, backed
by `/v1/settings/mcp-servers`.

### agents.json

Add entries to the `mcpServers` array in `agents.json`. Two transports are supported:
`stdio` (Monad spawns the server as a subprocess) and `http` (streamable HTTP to a
remote URL).

```jsonc
{
  "mcpServers": [
    {
      "name": "github",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "github-token-value" }
    },
    {
      "name": "linear",
      "transport": "http",
      "url": "https://mcp.linear.app/mcp",
      "auth": { "mode": "oauth" }
    }
  ]
}
```

Stdio fields: `name`, `transport: "stdio"`, `command`, plus optional `args`, `env`,
`cwd`, and `requestTimeoutMs`. HTTP fields: `name`, `transport: "http"`, `url`, plus
optional `auth`, `headers`, and `requestTimeoutMs`. Both accept `enabled` (default
`true`) and a `trust` block.

Edits apply live: the daemon diffs the new list against its open connections and only
connects added servers, disconnects removed ones, and reconnects edited ones. Unchanged
servers keep their subprocess and session; the agent sees the updated tool set on its
next turn.

## Protocol negotiation and Tasks

Monad probes each configured server for MCP `2026-07-28` first and falls back to the
legacy initialize handshake when needed. A single agent can therefore use modern and
legacy stdio or HTTP servers at the same time without per-server protocol flags.

When a modern server advertises `io.modelcontextprotocol/tasks`, Monad:

- sends a stable invocation id so retry-safe servers can deduplicate the initial tool
  call;
- persists the returned Task id and correlation metadata under the Monad data
  directory;
- subscribes to `notifications/tasks` on HTTP and stdio servers, periodically
  re-listens after finite streams, and uses `tasks/get` polling as a fallback;
- forwards structured `input_required` forms to the originating session while
  preserving string, boolean, number, and integer values and rejecting unsafe
  property names;
- retries transient reads with bounded backoff and propagates session cancellation
  through `tasks/cancel`; and
- resumes observation or a pending cancellation after the MCP connection is rebuilt;
  and
- bounds each server to eight active and 64 queued Tasks, records recovery/retry
  counters, honors server TTLs, and removes terminal journal records after seven days.

When recovery observes a terminal result or a new input request outside the original
agent turn, Monad stores the full snapshot as `deliveryPending` in the private journal
instead of silently fabricating a continuation of the old model turn.

The Web transcript renders active Tasks as progress cards with a stop-turn action that
propagates cancellation to the remote Task. A completed Task still
appears as the original tool result, with the related Task id retained in result
metadata. MCP App resources use the standard `ui/initialize` and postMessage data
notifications inside an opaque-origin sandbox; links are validated by the host and
require an explicit user confirmation, while unapproved iframe tool calls are rejected.
Legacy servers and modern servers without the extension continue through the ordinary
synchronous tool-call path.

## Secrets

MCP is a Monad-native feature and does not use Agent Runtime Credentials. Store HTTP
tokens, headers, OAuth state, and stdio environment values directly on the owning MCP
server in `agents.json`. Settings responses redact these values, but the user is
responsible for protecting the file. `${secret:...}` references are rejected.

## HTTP authentication

The `auth` field on an `http` server selects one of four modes:

- `{ "mode": "none" }` — no credentials (the default).
- `{ "mode": "bearer", "token": "mcp-token-value" }` — sent as an `Authorization: Bearer`
  header.
- `{ "mode": "headers", "headers": { "x-api-key": "mcp-key-value" } }` — arbitrary
  headers.
- `{ "mode": "oauth" }` — the standard MCP OAuth flow, orchestrated by the daemon.

### OAuth

For `oauth` servers, Monad runs discovery, dynamic client registration, and the
authorization-code + PKCE flow, then stores the tokens beside that server in
`agents.json`. Trigger it with
the Authorize button in the web UI or `monad mcp authorize <name>`; Monad opens your
browser and reconnects the server once authorization completes. Optional fields:
`clientId` (skips dynamic registration), `scopes`, and `flow` — `"loopback"` (browser +
localhost redirect, the default) or `"device"` (RFC 8628 device code for headless
daemons; requires a preconfigured `clientId`).

Daemon startup never opens a browser: at boot a stored token is refreshed silently or
the connection fails closed. A token that expires mid-session is re-authorized when an
agent tool call hits it.

## Trust controls

Each server takes an optional `trust` block:

- `autoApproveTools` — fully qualified tool names (`<server>__<tool>` form, e.g.
  `github__get_issue`) exempt from the per-call approval gate. Entries that match no
  advertised tool are logged as inert.
- `pinnedToolHash` — locks the server's advertised tool set. If the tools change after
  you vetted them (a rug-pull), the daemon refuses to register the server until you
  re-pin. On connect, an unpinned server's current hash is printed in the daemon log so
  you can copy it into config.
- `hostEscape` — marks a server whose tools drive your real machine (computer use).
  Its non-auto-approved tools can be approved for a session but never as a permanent
  "always allow".

Treat an MCP server like installed software: it executes with the access you give it, and its tool descriptions and outputs reach the model. Only connect servers you trust. The [runtime security model](/internals/infra/runtime#security-model) explains the surrounding containment boundary.

## Browser and computer presets

Setting `browser.enabled` or `computer.enabled` in `agents.json` synthesizes an MCP
server named `browser` or `computer` — no manual `mcpServers` entry needed. A
user-defined server of the same name takes precedence and the preset steps aside. See
[computer use & browser use](/usage/computer-use).

## Troubleshooting

- **Check status first.** `monad mcp status`, the Studio panel, or
  `GET /v1/settings/mcp-servers/status` show each server as connected, disabled, or
  failed, with its tool list.
- **A server failed at boot.** The reason is in the daemon log. Fix the config and save
  (the edit reconnects it), or force a retry with `monad mcp reconnect <name>`.
- **Connect fails because authentication is missing.** Re-enter the token or repeat
  OAuth authorization on the owning MCP server.
- **"tool set changed … refusing to register".** The server's tools no longer match
  `trust.pinnedToolHash`. Review the change, then update the pin to the new hash from
  the log.
- **An `autoApproveTools` entry has no effect.** Tool names must use the
  `<server>__<tool>` form; the warning in the daemon log lists the advertised names.
- **Two entries point at the same remote.** HTTP servers are deduplicated by normalized
  URL — the duplicate is skipped and logged.
