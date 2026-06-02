# Session origin: provenance, access policy & environment

Every session records **where it came from** in an immutable `origin` snapshot, stamped
once at creation and never mutated. It answers three separate questions — *who made this
session*, *who may act on it*, and *in what environment was it made* — and keeps them in
distinct layers so they never contaminate each other. Modeled after how MCP/LSP separate
client **identity** from **capabilities**, and how OpenTelemetry/Segment model
**environment context**.

The schema is `sessionOriginSchema` in [`@monad/protocol`](../packages/protocol/src/domain.ts);
it is one JSON column `sessions.origin`. A session with no origin (legacy rows) is
**unrestricted** — every check below no-ops.

## The layers

| Layer | Fields | Validation | Purpose |
|---|---|---|---|
| **identity** | `surface`, `client`, `clientVersion`, `instanceId` | strict | who/what created it |
| **access** | `writableBy`, `branchableBy` | strict | who may act on it |
| **environment** | `env.{os,ip,userAgent,referer,locale,workspace}` | strict, all optional | audit/telemetry |
| **extension** | `ext` | bounded JSON | open client-defined |

### identity — predefined core, open `client`

- `surface` — a **closed** enum (`editor` / `web` / `tui` / `im` / `api` / `automation`).
  Coarse, so it can key the default access policy. UIs may switch on it.
- `client` — an **open** string: `telegram`, `slack`, `zed`, `vscode`, `monad-web`. This is
  what makes "channel = many chat tools" and "web = many vendors" expressible without a
  schema change — a new tool is just a new string value.
- `instanceId` — disambiguates one surface across many instances (a channel id, a
  deployment/vendor id).

### access — two orthogonal policies

Both are `SessionTransport[]` (`http` | `acp` | `channel`). The **native JSON-RPC socket
(CLI/TUI) shares the `http` write-class** — both are owner-local control transports.

- `writableBy` — which transports may **send into** the session. Enforced by
  `assertWriteAllowed` in [messaging.ts](../apps/monad/src/modules/session/handlers/messaging.ts)
  on `send`/`generate` (`http`) and `sendInline` (`runOpts.transport`).
- `branchableBy` — which transports may **fork** the session. Enforced by
  `assertBranchAllowed` in [lifecycle.ts](../apps/monad/src/modules/session/handlers/lifecycle.ts),
  checking the **parent's** policy against the branching transport.

Both are **derived from `surface` at creation** (`DEFAULT_WRITABLE_BY` /
`DEFAULT_BRANCHABLE_BY` in [origin.ts](../apps/monad/src/modules/session/origin.ts)) **then
stored**, and **overridable** per session. Enforcement reads the *stored* policy — not a
call-site `surface→transport` lookup — so a session's rules stay stable even if defaults
change, and a session can be made (e.g.) writable-but-not-forkable.

Defaults: each surface's own transport only — `editor→[acp]`, `im→[channel]`,
`web/tui/api→[http]`, `automation→[]`. So by default the web client can neither write nor
fork an ACP or channel session; to allow collaboration, override `writableBy` /
`branchableBy` at creation.

### environment — audit only, **never to the model**

`env` is a per-transport **partial** snapshot: each transport fills what it can observe
(`ip`/`userAgent`/`referer`/`locale` = HTTP; `workspace` = ACP cwd; `os` = host). A missing
field means "that transport had no such thing", not an error. `env` is **PII** — see
[security-guidelines.md §7](security-guidelines.md): never fed to the model, never logged,
purged with the session.

### extension — strict core + open bag

`ext` (`sessionOriginExtSchema`) is the open half of a two-part contract: the predefined
core above is what UIs render structurally; `ext` is freeform client data a UI may only
render **raw**. It is client-controlled and persisted, so it is **bounded** (≤32 keys, ≤4KB
serialized) and, like `env`, never reaches the model. Sources: HTTP/jsonrpc body hint,
ACP `_meta.monad.ext` (validated). Channel has no client-declared ext source.

## Who stamps what

| Transport | surface | client | env | access default |
|---|---|---|---|---|
| HTTP (web) | `web` (body hint) | body hint / `monad-web` | ip·ua·referer·locale | `[http]` |
| JSON-RPC (CLI/TUI) | `tui` (hint) | `monad-cli` | — | `[http]` |
| ACP (editor) | `editor` | `clientInfo.name` | workspace·os | `[acp]` |
| channel (IM) | `im` | `c.type` (telegram/…) | — | `[channel]` |

Identity/policy hints are **client-declared** (a TUI sends `surface:'tui'`); `transport` and
`env` are filled **server-side** and never trusted from the body. A slash-command `/new`
inherits the running session's origin (a `/new` in Telegram stays Telegram). **Branch
stamps the branching transport's origin**, not the parent's — the parent stays reachable via
`parentSessionId`.

## Adding to the model

- New chat tool / web vendor → a new `client` string. **Zero schema change.**
- New collaboration rule → override `writableBy` / `branchableBy` data at creation.
- Client-private metadata → put it in `ext` (UI renders raw). **Zero schema change.**
- A genuinely new predefined dimension UIs must switch on → extend the strict schema.

Tests: [session-write-policy.test.ts](../apps/monad/test/unit/session-write-policy.test.ts).
