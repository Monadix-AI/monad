---
title: "The Daemon API"
sidebarTitle: "Daemon API"
description: "Build Monad clients and integrations against the local daemon's HTTP, SSE, and WebSocket APIs."
keywords: ["Monad API", "OpenAPI", "SSE", "WebSocket", "daemon client"]
---
Everything Monad can do is reachable over the daemon's local API — the Web UI, CLI, and
TUI are all just clients of it. This page is the orientation for writing your own client
or integration; the per-feature semantics live in the docs each section links to.

Transports, binding, and the security posture behind all of this:
[runtime.md](/internals/infra/runtime).

## Base URL and transports

The daemon serves the same REST + SSE API over two local channels at once:

| Channel | Address | Notes |
|---|---|---|
| TCP loopback | `http://127.0.0.1:<port>` (default `47749`) | Required for WebSocket push and the Web UI |
| Unix socket | `~/.monad/runtime/monad.sock` (mode `0600`) | Browser-safe; a web page cannot reach an AF_UNIX path |

`monad status --json` prints the address the local daemon is actually using. The port can
be overridden with `network.port` in `config.json` or the `MONAD_PORT` environment
variable.

There is also a no-port mode: `monad --stdio` speaks JSON-RPC over stdin/stdout and binds
nothing.

## Authentication

- **Loopback and Unix socket** — no token. The socket's filesystem permissions are its
  authentication; the loopback listener additionally validates `Origin` and `Host` so a
  web page cannot drive the daemon cross-site.
- **Remote access** — off by default. Setting `network.remoteAccess.enabled` binds
  `0.0.0.0` and requires `Authorization: Bearer <token>` on every non-loopback request.
  Plain HTTP sends that token in cleartext: put it behind TLS (reverse proxy, SSH tunnel,
  or VPN). See [runtime.md](/internals/infra/runtime) and
  [SECURITY.md](https://github.com/Monadix-AI/monad/blob/main/SECURITY.md).

## The two halves of the surface

**Universal methods** are declared once in `@monad/protocol`'s `METHOD_TABLE`
([`packages/protocol/src/rpc/method-table.ts`](https://github.com/Monadix-AI/monad/blob/main/packages/protocol/src/rpc/method-table.ts))
and are reachable over **both** REST and every JSON-RPC transport (WebSocket, Unix socket,
stdio). The RPC params schema and the REST verb + URL are both derived from that one
table, so the transports cannot drift. This is the agent-driving surface: sessions,
agents, `tools.approve`, `clarify.respond`, `skills.list`, `commands.list`.

**HTTP-only endpoints** have no JSON-RPC twin: the realtime streams, and the whole
management plane under `/v1/settings/*` (model, channels, MCP servers, ACP agents, peers,
locale) plus usage, stats, indexer, and init. Those controllers tag themselves
`detail.tags: ['http-only']`, and a parity test fails any route that is neither in
`METHOD_TABLE` nor tagged — so no endpoint exists silently.

## Realtime

Two planes, deliberately never merged — a token flood must not be able to starve approval
delivery. Full rules, resume semantics, and the client state machine:
[realtime-channels.md](/internals/infra/realtime-channels).

| Stream | Scope | Carries |
|---|---|---|
| `GET /v1/stream` (WebSocket, TCP only) | client lifetime | session/run/message lifecycle, tasks, approvals, connection state |
| `GET /v1/sessions/:id/messages/:messageId/stream` (SSE) | one active message | message snapshot, ordered deltas, terminal frame |
| `GET /v1/sessions/:id/ui-stream` (SSE) | one visible transcript | neutral `SessionUiEvent` projection for presentation |
| `GET /v1/sessions/:id/events` (SSE) | one session | session event log |

Standing SSE endpoints send heartbeat comments and support resume through both
`Last-Event-ID` and `?after=`. If a cursor is no longer available the server sends a
replacement snapshot rather than silently skipping state.

## Errors

Every 4xx/5xx returns one JSON envelope:

```json
{
  "error": "human-readable description",
  "code": "VALIDATION",
  "retryable": false,
  "requestId": "req_...",
  "details": { "field": "title" }
}
```

`code` is a machine-readable tag (`VALIDATION`, `NOT_FOUND`, `INTERNAL`, `UNAUTHORIZED`,
…); `retryable` says whether repeating the request can succeed; `requestId` is echoed in
the `x-monad-request-id` response header so a client can correlate a failure with the
daemon log. `details` is a bounded string map (at most 16 entries) — never a stack trace.

## Retries and concurrency

- **Idempotency** — mutating requests may carry an `Idempotency-Key` header. The daemon
  deduplicates retries within one daemon lifetime; a restart intentionally clears that
  memory.
- **Compare-and-swap** — shared mutable records (session plans, member bindings) take an
  expected version so a lost update fails loudly instead of silently overwriting.

Idempotency and CAS solve different problems: the first protects against a retried
request, the second against two writers.

## Local Scalar API reference

The hosted Mintlify site does not publish the daemon's OpenAPI document. When developing
Monad locally, the daemon can instead serve Scalar at `/docs`, generated directly from
the routes in that checkout. Scalar includes internal and developer-only routes, so it is
**developer-mode only** and is not a public API compatibility promise.

Start the source development environment, then enable developer mode:

```bash
monad config set developerMode true
monad restart
monad status
```

Open the Scalar URL printed by `monad status`, normally
`http://127.0.0.1:<port>/docs`. The raw OpenAPI document is available beside it at
`http://127.0.0.1:<port>/docs/json` for local inspection and tooling.

Route-authored summaries, descriptions, and tags appear unchanged. The developer-mode
document supplies readable fallbacks for any route that has not authored those fields yet,
so every operation remains navigable while route owners progressively improve its precise
contract text.

Turn developer mode off when finished:

```bash
monad config set developerMode false
monad restart
```

Both changes require a restart because developer-only routes are selected when the HTTP
transport starts. Do not expose the Scalar URL through a public reverse proxy.

## Foreign-protocol adapters

Besides its own API, the daemon can speak protocols other tools already understand:

| Surface | Endpoint | Enable with |
|---|---|---|
| OpenAI-compatible | `/openai/v1/chat/completions`, `/embeddings`, `/models`, `/responses` | `openaiCompat.enabled` in `config.json` |
| A2A (Agent2Agent) | `/a2a/agents/:agentId` + its agent card | per-agent toggle |
| MCP server | `POST /v1/agents/:id/mcp` | exposes an agent as an MCP server |
| ACP | stdio via `monad acp` | editors; see [acp.md](/internals/agent-team-runtime/acp) |

The OpenAI-compatible endpoint is also what
[peer federation](/internals/agent-team-runtime/peer-federation) uses as its
transport between two daemons you own. Enabling it accepts inbound work: read the
inbound-approval policy (`openaiCompat.approval`) before turning it on.

## Client libraries

Prefer the packages over hand-rolling HTTP:

- **`@monad/client`** — typed daemon client: Treaty calls, SSE and WebSocket parsing,
  version checks. Validates every event frame against the protocol schemas before handing
  it to you.
- **`@monad/client-rtk`** — RTK Query cache layer shared by the Web UI and TUI.
- **`@monad/protocol`** — the schemas and types themselves. Import and derive from these
  rather than redeclaring shapes; they are the single producer for every wire contract.

## Scripting without a client library

`monad <command> --json` covers most automation without touching HTTP at all — stable exit
codes, NDJSON event streams, stdin via `-`. See [cli.md](/usage/cli#scripting).
