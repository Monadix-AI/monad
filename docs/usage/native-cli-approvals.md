# Native CLI agent approvals

Native CLI agents (Codex, Claude Code, Gemini, Qwen, OpenClaw, Hermes) own their own approval
prompts — when a tool call needs approval, the *provider* decides whether to ask. Monad never
second-guesses that decision or applies its own approval policy to a native CLI. What Monad
controls is a single switch per managed agent: whether those provider approvals run **on
autopilot** or are **delegated to a human through Monad's UI**.

## The switch: autopilot

The switch is the agent's `allowAutopilot` flag (agent template, on by default) plus a per-member
override (`WorkplaceProjectMemberSettings.allowAutopilot`). The daemon resolves `member ??
template` at launch.

- **Autopilot ON (default) →** the managed agent launches with the provider's skip-approval flag:
  `codex --ask-for-approval never`, `claude --dangerously-skip-permissions`,
  `gemini/qwen --approval-mode=yolo`, `hermes --yolo` (all confirmed against each CLI's official
  docs — see the per-adapter source comments for exact citations). **OpenClaw is the exception: it
  has no such flag** (see "OpenClaw has no autopilot flag" below) — autopilot is a no-op for it
  today. Where a flag exists, it runs unattended and any approval that still leaks through is
  auto-denied (`host.ts` suppression branch). `allowAutopilot` also gates a small set of dangerous
  provider argv flags — off, those are rejected too.
- **Autopilot OFF → delegated.** The skip flag is dropped, so the provider projects its own
  approval requests. Monad is a **UI proxy**: it surfaces each request in the project room's
  approval stack and relays the human's allow/deny back to the provider. Monad's `OversightService`
  / policy engine is **not** involved — the provider still decides what to ask and how to apply the
  answer.

Delegation is only possible where the provider exposes a two-way approval channel **in the launch
mode a session actually uses**. Two independent gates:

- `adapter.supportsApprovalResolution(launchMode)` — the daemon's per-session gate, keyed by the
  *effective* launch mode (member override, or the provider's managed default). This is what
  `host.start` actually consults, so it's correct even for a launch mode a provider doesn't use by
  default.
- `capabilities.approvalProxy` (boolean) — drives the settings UI toggle. It has **no notion of
  launch mode**, so an adapter only sets it when its *managed default* mode is itself resolvable —
  otherwise the toggle would appear to work but silently have no effect for the common case.

App-server's resolve channel is **transport-agnostic**: `resolveApproval` always writes through
`handle.appServer.send(...)`, a uniform abstraction over stdio, ws, or unix — Codex/OpenClaw/Hermes
all speak app-server over different transports, and none of that matters to the capability check,
only the launch mode does.

## Capability matrix

| Provider | Managed default mode | Resolvable mode? | UI toggle | Resolve channel |
|---|---|---|---|---|
| Codex | app-server (stdio) | ✅ (app-server) | ✅ shown | JSON-RPC response (`codex/runtime.ts`) |
| Qwen | json-stream | ✅ (json-stream) | ✅ shown | stream-json `control_response` (`qwen/stream-json.ts`) |
| OpenClaw | app-server (ws) | ✅ (app-server) | ✅ shown | JSON-RPC response (`app-server-jsonrpc.ts`) |
| Claude Code | json-stream | ❌ (no mode) | ❌ hidden | none (resolution throws) |
| Gemini | json-stream | ❌ (no mode) | ❌ hidden | none (resolution throws) |
| Hermes | **cli-oneshot** | ✅, but only in **app-server (ws)** — a *different* mode than the managed default | ❌ hidden | `approval.request`/`approval.respond` over ws (`hermes/app-server.ts`) |

Hermes is the one case where the two gates diverge on purpose: `supportsApprovalResolution` is
`true` for `app-server` (Hermes's gateway really can proxy approvals), but `capabilities.approvalProxy`
stays `false` because Hermes's *managed* launch mode defaults to `cli-oneshot` (proven end-to-end
with a real LLM turn; app-server is untested in that role — see `hermes/index.ts`). An operator can
still reach delegation for a Hermes member by explicitly setting that member's `launchMode` to
`app-server` (`managedProjectLaunchMode` honors an explicit override over the provider default) —
the host-level gate correctly delegates in that case even though the simple per-template toggle
doesn't advertise it.

To lift a lock later (e.g. a Claude Code permission-prompt bridge, or switching Hermes's managed
default to app-server once proven), implement/confirm the resolvable channel and flip
`supportsApprovalResolution` + (if the *managed default* mode is what's now resolvable)
`capabilities.approvalProxy` — no other daemon or UI change is needed.

## OpenClaw has no autopilot flag

Every skip-approval flag in this file was verified against the provider's own official docs (see
each adapter's source comments for exact citations) — this one didn't check out. OpenClaw's exec
approvals have **no CLI flag or env var** that bypasses them
(docs.openclaw.ai/tools/exec-approvals: *"no single CLI flag or env var"* does this); the only real
mechanism is its own config (`tools.exec.security`/`ask`) plus a separate host-local approvals file
(`defaults.askFallback`), or the `openclaw exec-policy preset yolo` shortcut that writes both.

The shared app-server adapter factory used to append a plain nonexistent `--auto-approve` flag for
both OpenClaw and Hermes. That's fixed — `MakeAppServerCliAdapterOptions.skipApprovalFlag` is now
per-adapter (Hermes sets it to the real `--yolo`; OpenClaw omits it, so nothing is appended). But a
config-file-based fix (writing OpenClaw's own policy files and pointing the child at them via
`OPENCLAW_HOME`/`OPENCLAW_STATE_DIR`) was investigated and **deliberately not implemented**: OpenClaw's
credential store (`auth-profiles.json` under `~/.openclaw/agents/<agentId>/agent/`) "also respects
`$OPENCLAW_STATE_DIR`" per its own auth docs, so redirecting either var to scope an exec-approvals
override would silently strand the managed session with no stored auth. A correct fix needs either a
verified credential-preserving injection or hands-on verification against the real binary — see the
comment in `openclaw/index.ts` for the full reasoning. **Net effect: OpenClaw managed agents do not
currently support autopilot** (no flag is sent, so it stops silently doing the wrong thing, but it
still prompts with no channel to answer while unmanaged); delegated mode is unaffected and works
today via the real app-server approval channel.

## Flow (delegated)

1. `host.start` computes `proxyApprovals = managed && allowAutopilot === false &&
   adapter.supportsApprovalResolution(effectiveLaunchMode)` and passes
   `skipProviderApprovals: managed && !proxyApprovals` (skip stays on unless delegating).
2. The provider emits an `approval_requested` event; the host projects it as
   `native_cli.approval_requested` and records it in `pendingApprovals` (the same path interactive
   sessions use).
3. The project room's `ApprovalStack` renders it (`approvalOwnership: 'provider-owned'`); the human
   approves/denies via `POST /native-cli-sessions/:id/approval`.
4. `host.resolveApproval` calls `adapter.resolveApproval`, which writes the provider's response, and
   emits `native_cli.approval_resolved`.

## Non-regression

Agents with autopilot **ON** (the default) are unaffected: the skip flag is still applied and
leaked approvals are still auto-denied — identical to today's behaviour. Delegation is opt-in per
agent/member (autopilot OFF) and only takes effect for proxy-capable providers; everywhere else the
setting is locked ON with an explanatory hint, so turning it off never leaves an agent stuck with
no way to answer its own approval prompts.
