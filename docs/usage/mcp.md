# MCP servers

MCP (Model Context Protocol) is an open standard that lets an agent call tools served by
an external process or remote service. monad connects to the MCP servers you configure
and merges their tools into the agent's toolbox: a remote tool appears to the model as
`<server>__<tool>` (for example `github__create_issue`) and behaves like any built-in
tool. MCP tools cross a trust boundary, so they are high-risk by default — every call
routes through the approval gate unless you explicitly auto-approve it (see
[Trust controls](#trust-controls)).

Servers connect at daemon startup. A server that fails to connect is logged and skipped —
it never blocks startup or the other servers.

## Adding a server

### Web UI

Open Studio → Capabilities → MCP Servers. The panel lists every configured server with
live connection status (connected, disabled, or failed) and its advertised tools, and
lets you add, edit, enable or disable, authorize (for OAuth servers), reconnect, and
remove servers. It is backed by the REST surface under `/v1/settings/mcp-servers`.

### config.json

Add entries to the `mcpServers` array in `config.json`. Two transports are supported:
`stdio` (monad spawns the server as a subprocess) and `http` (streamable HTTP to a
remote URL).

```jsonc
{
  "mcpServers": [
    {
      "name": "github",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${env:GITHUB_TOKEN}" }
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

### CLI

`monad mcp` manages servers from the terminal:

- `monad mcp list` / `monad mcp status` — installed servers and live connection health
  across every source.
- `monad mcp search <query>` — search the official MCP registry, Glama, Smithery, and
  the built-in catalog.
- `monad mcp add <name> <command> [args…]` or `monad mcp add <name> --url <url>` —
  install a server as a hot MCP atom under `~/.monad/atoms/mcp/` (no restart). Servers
  that need auth belong in `config.json` instead.
- `monad mcp enable|disable|remove <name>` — manage installed atoms.
- `monad mcp authorize|reconnect <name>` — act on `config.json` servers (see OAuth
  below).

## Secrets

Never put a raw token in `config.json`. String values in `env`, `headers`, and
`auth.token` accept secret references, resolved when the daemon connects:

- `${env:NAME}` — read from the daemon's environment. Connecting fails if the variable
  is unset.
- `${secret:NAME}` — read from `auth.json`'s named secrets store.

## HTTP authentication

The `auth` field on an `http` server selects one of four modes:

- `{ "mode": "none" }` — no credentials (the default).
- `{ "mode": "bearer", "token": "${env:MY_TOKEN}" }` — sent as an `Authorization: Bearer`
  header.
- `{ "mode": "headers", "headers": { "x-api-key": "${env:MY_KEY}" } }` — arbitrary
  headers.
- `{ "mode": "oauth" }` — the standard MCP OAuth flow, orchestrated by the daemon.

### OAuth

For `oauth` servers, monad runs discovery, dynamic client registration, and the
authorization-code + PKCE flow, then stores the tokens in `auth.json`. Trigger it with
the Authorize button in the web UI or `monad mcp authorize <name>`; monad opens your
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

Treat an MCP server like installed software: it executes with the access you give it,
and its tool descriptions and outputs reach the model. Only connect servers you trust —
see [security guidelines](../engineering/security-guidelines.md).

## Browser and computer presets

Setting `browser.enabled` or `computer.enabled` in `config.json` synthesizes an MCP
server named `browser` or `computer` — no manual `mcpServers` entry needed. A
user-defined server of the same name takes precedence and the preset steps aside. See
[computer use & browser use](computer-use.md).

## Troubleshooting

- **Check status first.** `monad mcp status`, the Studio panel, or
  `GET /v1/settings/mcp-servers/status` show each server as connected, disabled, or
  failed, with its tool list.
- **A server failed at boot.** The reason is in the daemon log. Fix the config and save
  (the edit reconnects it), or force a retry with `monad mcp reconnect <name>`.
- **Connect fails with a secret reference error.** The `${env:…}` variable is not set in
  the daemon's environment, or the `${secret:…}` name is absent from `auth.json`.
- **"tool set changed … refusing to register".** The server's tools no longer match
  `trust.pinnedToolHash`. Review the change, then update the pin to the new hash from
  the log.
- **An `autoApproveTools` entry has no effect.** Tool names must use the
  `<server>__<tool>` form; the warning in the daemon log lists the advertised names.
- **Two entries point at the same remote.** HTTP servers are deduplicated by normalized
  URL — the duplicate is skipped and logged.
