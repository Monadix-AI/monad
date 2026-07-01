# Runtime: transport, configuration & security model

How the daemon binds, how local clients reach it, and the security posture that
follows from that design. These are the deep technical details kept out of the
[README](../README.md). For the **code-level** rules that enforce the posture
below, see [security-guidelines.md](security-guidelines.md).

## Configuration

Most settings live in `~/.monad/config.json` (created on first run). The daemon
port, bind address, client transport, and remote-access token are all stored there
— no env vars needed for normal use.

## Transport

> **Two distinct axes share this name — don't confuse them:**
>
> - **Physical transport** (this section) — *how bytes travel*: `tcp` (HTTP over
>   `127.0.0.1`) or `uds` (HTTP over Unix socket). Configured via `network.transport`
>   in `config.json`.
> - **Semantic transport** (see [session-origin.md](session-origin.md)) — *who may
>   write or fork a session*: `http` (local control transports — CLI, TUI, web UI),
>   `acp` (editor agents), or `channel` (chat tools). This is the `SessionTransport`
>   enum in `@monad/protocol`'s `domain.ts`, stored on the session's immutable
>   `origin` snapshot and used for `writableBy`/`branchableBy` policy. Both `tcp` and
>   `uds` connections are classified as `http` in this sense.
>
> The rest of this section covers physical transport only.

The daemon always serves its HTTP API over **two** local channels at once: TCP
loopback (`127.0.0.1:<port>`) and a Unix-domain socket (`~/.monad/run/monad.sock`).
Both carry the same REST + SSE API; WebSocket push (`/v1/stream`) and the browser
web UI are TCP-only.

> Which realtime events travel over WebSocket vs SSE — and the rule that a session's
> generation stream must be subscribed explicitly over SSE, never pushed over the WS
> control plane — is its own decision: see
> [realtime-channels.md](realtime-channels.md).

Local clients (the CLI) choose which one to dial via `network.transport` in
`config.json`:

| value | meaning |
|---|---|
| `uds` | HTTP over the Unix socket — **default on every platform** |
| `tcp` | HTTP over `127.0.0.1` loopback |

`uds` is the default everywhere: Bun supports AF_UNIX on all platforms monad
targets — including Windows (native since Windows 10 1803) — the daemon binds the
socket on all of them, and a Unix socket is browser-safe (a web page can reach
`127.0.0.1` but not an AF_UNIX path). It's overridable at any time:

```bash
monad config get network.transport       # show current transport
monad config set network.transport tcp   # switch (applies to the next command — no restart)
```

If `uds` is selected but the socket can't be connected (older daemon, missing
socket file, a host where the bind failed, …), the client automatically falls back
to TCP loopback for that run — the setting never makes the CLI unreachable. The
daemon likewise falls back to TCP-only if it can't bind the socket, so it stays
reachable everywhere.

> This per-OS default + automatic fallback is decided **inside** the transport
> adapter, not in feature code — the canonical example of the thin-glue-layer rule
> in [design-principles.md](design-principles.md).

### Which methods speak which transport

The request/response API splits in two:

- **Universal methods** — reachable over **both** REST and all JSON-RPC transports
  (WebSocket / Unix socket / stdio). These are the agent-driving surface: sessions,
  agents, `tools.approve`, `clarify.respond`, `skills.list`, `commands.list`. They are
  declared once in `@monad/protocol`'s `METHOD_TABLE`; the RPC params schema and the
  REST verb+URL are both derived from it, so the two transports cannot drift.
- **HTTP-only endpoints** — REST only, no JSON-RPC twin: real-time streams
  (`GET /v1/sessions/:id/events` SSE), push (`/v1/stream`), and the whole management
  plane under **`/v1/settings/*`** (model / channels / MCP servers / ACP agents /
  locale) plus usage, stats, indexer, init and delegation. Settings are deliberately a
  REST-only management surface — an embedded stdio host drives agents, it doesn't
  reconfigure the daemon.

  Such routes declare themselves at the controller via Elysia's
  `detail.tags: ['http-only']` (a fully-HTTP-only controller sets it once on the
  instance: `new Elysia({ tags: ['http-only'] })`). The route-table-parity test derives
  the exemption set from those tags, so there is no hand-maintained allowlist — but
  adding a route with neither a `METHOD_TABLE` entry nor the tag fails the test on
  purpose (the "no silent endpoint" guard).

## Environment variables

These are bootstrap-only. Everything else is in `config.json`.

| Variable | Default | Purpose |
|---|---|---|
| `MONAD_HOME` | `~/.monad` | Root directory for all daemon-managed files |
| `MONAD_PORT` | _unset_ | Overrides `config.json`'s `network.port` for the daemon's listener **and** its clients (they read the same var to stay in sync). Unset → the configured port is used. E.g. `MONAD_PORT=8000 monad`. |
| `MONAD_STDIO` | _unset_ | When `true` (or `--stdio`), the daemon speaks JSON-RPC over stdin/stdout and binds **no** TCP port or socket (embedded/single-client use) |

> In the repo's dev setup, `scripts/setup-dev.ts` auto-assigns a per-worktree `MONAD_PORT`
> (and `WEB_PORT`) into `.env.local` so multiple git worktrees can run `bun dev` at once
> without port clashes. That auto-assignment is dev-only tooling — it is never part of a
> release build; the daemon's `MONAD_PORT` read is, so release users can set it by hand.

## Security model

monad is a **local, single-user daemon**. By default it binds the **loopback
interface only** (`127.0.0.1`) plus the Unix socket under `~/.monad/run/` — neither
is reachable from other machines. A bound loopback port is **not** an exposed port.
The in-scope adversaries today are the user's **own web browser** (any page can
reach `127.0.0.1`) and, once tools land, the **model's own tool calls** — not (yet)
a remote network attacker.

- **No network exposure by default.** Loopback + UDS are local-only.
- **Remote access is explicit opt-in.** Setting `network.remoteAccess.enabled` binds `0.0.0.0` and requires a bearer token (`Authorization: Bearer …`) for every non-loopback request. Plain-HTTP remote access sends that token in cleartext — put it behind TLS (reverse proxy / SSH tunnel / VPN); never expose `http://0.0.0.0:<port>` directly.
- **Credentials** live in `~/.monad/auth.json`, written `0600` (owner-only).
- **No-port mode.** `monad --stdio` / `MONAD_STDIO=true` talks JSON-RPC over stdin/stdout with no port and no socket.

> This is an **evolving** posture, not a hardened one. The loopback-trust model
> means a malicious local web page is in scope, and the loopback IP check answers
> "did this come from this machine?" — never "is this caller allowed?". The
> corresponding hardening (Origin/Host validation, WebSocket origin checks, locking
> permissions on the socket and `config.json`, tool-argument sandboxing) is tracked
> in **[security-guidelines.md](security-guidelines.md)**. Read it before changing
> anything that touches a network boundary, the filesystem, a credential, or tool
> dispatch.
