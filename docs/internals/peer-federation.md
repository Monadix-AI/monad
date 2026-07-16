# Peer federation — daemon-to-daemon task delegation

One Monad daemon can delegate a self-contained task to a **peer** Monad daemon's agent (compute
federation). The caller's agent invokes the `agent_peer_delegate` tool; the peer runs the subtask on
its **own** filesystem, tools, and credentials, and streams the answer back as the tool's result.

This is the inverse of [ACP delegation](acp.md): there Monad drives an external ACP agent over stdio
(and serves *its* files/terminal); here Monad drives a networked **Monad peer** that is fully
self-contained — there is **no filesystem/terminal bridge-back**.

> **Ownership boundary.** This mechanism assumes the two daemons share a single owner (same person).
> Cross-owner collaboration (different people, independent trust/billing) is **not** this feature —
> that is A2A / Monadix territory and has its own design.

## Architecture — the tool is an OpenAI-compat client

P0 reuses the daemon's existing **OpenAI-compatible HTTP endpoint** (`/openai/v1/chat/completions`,
see [runtime.md](runtime.md)) as the transport. The delegating daemon (A) is just another OpenAI
client pointed at the peer (B); B drives a normal agent session and streams tokens back.

```
daemon A                                             daemon B (the peer)
  agent.loop                                           POST /openai/v1/chat/completions
   └─ agent_peer_delegate tool ──HTTP(SSE)──▶          └─ session.create + sendInline
       (services/peer-delegate.ts)                         └─ agent.loop runs on B's OWN tools/creds
   ◀──────── streamed answer (tool result) ─────────────── agent.token … agent.message
```

Both daemons run their **own** agent loop. A's outbound call carries the peer's bearer token; B
authenticates it like any OpenAI-compat caller and runs the instruction as an `surface:'api'` session.

Key files:

- `apps/monad/src/services/peer-delegate.ts` — the `agent_peer_delegate` tool (high-risk; streams
  SSE; the model supplies a peer **name**, never a URL/token). Composed through
  `agent/execution.ts` with the enabled, token-resolved peer tools.
- `packages/environment/src/config.ts` — `peers[]` (system config) + `peerCredentials` in `auth.json` +
  `resolvePeerSecretRef`.
- `apps/monad/src/modules/settings/peer/` + `transports/http/peer-settings/controller.ts` — settings
  CRUD (`/v1/settings/peers`), driven by `monad peer …`.
- `apps/monad/src/services/inbound-approval.ts` — the inbound approval gate wrapper (see below).
- `packages/protocol/src/peer.ts` — the settings wire DTOs (no secrets cross the wire).

## Configuration

A peer is infra/security config (a delegation target + its credential), so it lives in **system
config** (`config.json`, like `mcpServers`/`acpAgents`) — changes apply on the next daemon start. The
token never sits in `config.json`; it lives in `auth.json` behind a `${secret:peer/<id>/token}` ref.

```jsonc
// config.json
"peers": [
  {
    "id": "peer_HOME00000000",
    "label": "home-node",
    "baseUrl": "https://home.example:52749/openai",  // the peer's OpenAI-compat base (no /v1)
    "defaultAgent": "default",                        // target agent when the model names none
    "tokenRef": "${secret:peer/peer_HOME00000000/token}",
    "enabled": true
  }
]
```

CLI (mirrors `monad channel`):

```
monad peer add <base-url> --label <name> --agent <agent>   # create (disabled)
monad peer token <id> <token>                              # store token in auth.json + enable
monad peer list                                            # configured peers (no secrets)
monad peer enable|disable <id>
monad peer remove <id>                                     # also drops the credential
```

Trust is **manual**: the operator enables `openaiCompat` on B, shares B's token out-of-band, and adds
a peer entry on A with that token.

## Inbound approval — `openaiCompat.approval`

When B's delegated agent hits a **high-risk tool** (shell, write, network), it needs an approval
decision. The OpenAI-compat stream has **no interactive approval channel**, so the request cannot be
forwarded back to A's user (that arrives with PeerLink — see roadmap). Without handling, the call
would hang. B resolves it via a per-daemon policy on its OpenAI-compat surface:

| `openaiCompat.approval` | Behaviour |
|---|---|
| `auto` (default) | Auto-approve. Same-owner rationale: A's `agent_peer_delegate` tool is itself high-risk and was already approved on A once — that authorizes the whole subtask. The loop self-closes with no human on B. |
| `local` | Leave it to **B's own** clients — the delegated session is a normal session whose events still reach the bus, so B's Web/TUI prompts as usual. Unattended B → the call waits, then times out (deny). |
| `deny` | Reject all high-risk tools (read-only delegation). |

The policy is applied by `createInboundApprovalGate` (`services/inbound-approval.ts`), which wraps the
oversight gate and keys off `session.origin.client === 'openai-compat'`. The daemon's **own** sessions
(Web/TUI) are unaffected. The setting is **hot-reloaded** (it lives in profile config; a `profile.json`
edit or settings change applies without a restart).

> **Note on breadth.** P0 inbound requests don't carry a peer identity, so the policy applies to *all*
> OpenAI-compat callers, not only peers. `auto` flips the prior effective-deny-after-timeout to
> auto-allow for high-risk tools — appropriate under the same-owner + token-as-trust-boundary
> assumption, and configurable to `local`/`deny`.

## Security model

- **The model names a peer, never a URL/token** — preventing SSRF and credential leakage (same rule as
  `agent_acp_delegate` forbidding raw commands). Only operator-configured, enabled peers are reachable.
- **High-risk gate on A** — `agent_peer_delegate` is high-risk, so each delegation passes A's oversight
  gate once before any network call.
- **Secrets in `auth.json`** (mode `0600`), never `config.json`; settings responses never echo the
  token back.
- **Same-owner assumption** — `auto` inbound approval is sound only because A and B are the same person.
  Cross-owner setups must use `local`/`deny`, or A2A/Monadix instead.

See [security-guidelines.md](../engineering/security-guidelines.md) for the general agent-containment rules.

## Roadmap — PeerLink (P1)

P0 requires the peer to be **network-reachable** and supports only `local`/`auto` approval. The next
phase is **PeerLink**: a bidirectional JSON-RPC link over one WebSocket (`/v1/peer`) that adds

- **NAT traversal via reverse tunnel** — the NAT'd daemon dials out; the link is symmetric, so either
  side can initiate a delegation once connected (connect direction ⟂ request direction).
- **`forward` approval** — B's approval request streams back to A over the link (`peer.delegate.approve`
  reverse-RPC), so the initiating daemon's human can decide.
- **Peer-scoped isolation** — inbound delegations use a restricted per-peer handler facade and a
  `'peer'` session transport/surface, with capabilities and approval policy enforced at that boundary.

The `agent_peer_delegate` tool would then become transport-pluggable (`direct` = OpenAI-compat |
`link` = PeerLink). The full design lives in the team's planning notes.

## Testing

- `apps/monad/test/unit/peer-delegate.test.ts` — the tool's HTTP/SSE client against a capture server:
  request construction, agent override, trailing-slash, multi-chunk/`[DONE]`/malformed-frame parsing,
  JSON-vs-non-JSON errors, no-token-leak.
- `apps/monad/test/unit/inbound-approval.test.ts` — the gate policy (auto/local/deny + non-delegation /
  missing-session edges).
- `apps/monad/test/e2e/peer-settings.test.ts` — settings CRUD over a real temp `~/.monad` (secret stays
  in `auth.json`).
- `apps/monad/test/e2e/peer-delegate.test.ts` — a real B daemon over loopback: tool-level closed loop +
  a **true two-daemon** test where A's real agent loop emits the tool call and answers from B's result.
- `packages/environment/test/unit/peer-secret.test.ts` — `resolvePeerSecretRef`.
