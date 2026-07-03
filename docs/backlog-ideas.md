# Backlog ideas

Ideas discussed and worth remembering, but with no current commitment to implement.
Each entry records the reasoning behind the idea and why it was deferred — so that if
context changes the argument can be revisited without starting from scratch.

**Status vocabulary**

| Status | Meaning |
|--------|---------|
| `parked` | Discussed; not in scope now; re-evaluate when noted condition is met |
| `rejected` | Discussed; actively decided against; reason recorded |
| `watching` | No action yet; keeping an eye on the ecosystem/demand signal |

---

## TOML config format

**Status:** `parked`
**Discussed:** 2026-06-22

Migrate `config.json` / `profile.json` / `auth.json` / `approvals.json` to TOML format.

**Why it came up:** TOML is more human-friendly (comments, unquoted keys, cleaner table
nesting) and a better fit for the `monad config edit` workflow where users open the file
in their editor.

**Why it's parked:**

- JSON + `$schema` already gives editor validation out of the box (VS Code built-in).
  TOML has no native schema standard — reaching parity requires the taplo ecosystem
  (`Even Better TOML` extension + `#:schema` pragma comment).
- Non-trivial blast radius: read/write logic, path constants, migration, tests, and
  template files all need updating.
- TOML has no `null` type; the serialisation layer needs deep null-filtering before
  calling `stringify`.

**Re-evaluate when:**
- Users report friction editing config files by hand.
- The project adopts taplo/TOML elsewhere anyway.

**Minimum-cost path if revisited:**
- Library: `smol-toml` (already a transitive dep — promote to direct)
- Editor validation: taplo + existing `SCHEMA_CONTENT` generation; write `#:schema` pragma as first line of each file
- Backward compat: on startup, if `.json` exists and `.toml` does not, auto-migrate once (idempotent)
- Core changes: `packages/home/src/config.ts` (load/save functions) and `packages/home/src/paths.ts` (filename constants)

---

## GraphQL endpoint

**Status:** `parked`
**Discussed:** 2026-06-20

Add a `/v1/graphql` endpoint (e.g. via graphql-yoga) alongside the existing REST + RPC
transports, exposing the same method surface with flexible client-driven querying.

**Why it came up:** GraphQL offers flexible data-shape queries for complex UIs and is a
popular integration target for third-party tooling (low-code platforms, BI tools).

**Why it's parked:**

- `packages/protocol/src/method-table.ts` is the single schema source of truth from which
  REST and RPC contracts are derived and kept in sync by tests. A GraphQL SDL or
  code-first schema would be a third contract — maintenance drift risk without clear payoff.
- Real-time is already covered by SSE + multiplexed WebSocket; GraphQL subscriptions
  would be redundant and less mature on the Bun/Elysia stack.
- Streaming token output (the hot path) maps poorly to GraphQL's query/mutation model.
- The existing OpenAI-compat endpoint covers the dominant AI-tooling integration use case.
- GraphQL introduces additional attack surface: introspection exposure, deep-query
  complexity attacks, batch abuse — on top of the existing auth/rate-limit layer.

**Re-evaluate when:**
- The web UI grows into a dashboard with multiple clients needing different data shapes.
- A specific third-party integration explicitly requires GraphQL.
- A Federation / multi-service aggregation need emerges.

**Minimum-cost path if revisited:** graphql-yoga on Bun, code-first schema auto-derived
from the zod schemas in method-table.ts, mounted at `/v1/graphql`, HTTP-enabled methods
only. Still a non-trivial lift — estimate 3–5 days to do it safely with security
mitigations and parity tests.

---

## Incognito run mode

**Status:** `parked`
**Discussed:** 2026-06-22

A session flag (`/incognito` slash command) that prevents the agent from writing to
long-term memory during that run. Model A (recommended first): reads existing memory,
writes nothing new. Model B (optional later): full isolation — zero memory in or out.

**Why it came up:** Users sometimes want a conversation that won't pollute long-term
memory — sensitive topics, throwaway experiments, demos.

**Why it's parked:**

- The memory system (mem0 integration, `memoryTool`) is still evolving; pinning a
  write-suppression layer on top risks being invalidated by upcoming memory-design
  changes.
- Demand signal is low — no user request yet; only internal design discussion.
- The implementation is small (session flag + guards in `services/memory/index.ts`)
  but needs UX surface (badge, prompt nudge) in web + TUI, which adds scope.

**Re-evaluate when:**
- Memory design stabilises past the current draft state.
- A user explicitly asks for "don't remember this" behaviour.

**Minimum-cost path if revisited:** See `docs/proposals/incognito-run-mode.md` for the
full spec. Core work: `incognito` boolean on session model + store row; built-in
`/incognito` command; guards in `memoryTool` / `observeTurn` / `recallContext`; session
badge in web/TUI. Estimated 1–2 days.

---

## Dynamic agent orchestration routing

**Status:** `parked`
**Discussed:** 2026-06-29

A per-turn router that picks the orchestration mode: simple tasks stay on the existing
single-agent `AgentLoop`; complex tasks enter an "orchestrator + multi-role" mode that
reuses the same loop with an injected orchestrator system prompt + a larger tool-step
budget, letting the model fan out via the existing `agent_delegate` (anonymous fork) and
`agent_delegate_to` (named Studio agent) tools. `mode=auto` by default, with a
heuristic-short-circuit → fast-model-classifier router, an observable `agent.routing`
event, and a config override (`single`/`multi`, per-agent overridable).

**Why it came up:** Single-thread loops are right for most work, but comprehensive /
confidence-critical / scale tasks ("compare X/Y/Z and research each", broad audits) benefit
from parallel read-only fan-out. The route is validated by prior art: Anthropic's
multi-agent research system embeds complexity rules in the orchestrator prompt (1 agent for
lookups, 2–4 for comparisons, more for broad research) and reports large gains; GPT-5 uses
an explicit complexity router (and teaches the lesson: don't hide the routing decision).
Cognition's *Don't Build Multi-Agents* shapes the design defensively — keep multi-agent to
read-only fan-out, keep writes on the main thread, default to single on uncertainty.

**Why it's parked:**

- Monad already has all the primitives (`AgentLoop`, `runSubagent()` in
  `apps/monad/src/agent/delegate.ts`, both delegate tools, per-role model resolution), so
  the model can *already* delegate mid-turn — the incremental value is an explicit,
  observable up-front decision, not new capability. Demand signal is internal-only so far.
- The router adds a per-turn classification call (cost/latency) on the hot path; the
  heuristic short-circuit mitigates it but the win needs a real before/after measurement
  the project hasn't taken.
- GPT-5's experience flags the core risk: a mis-routed "complex-as-simple" gives shallow
  answers — tuning the classifier well is the actual work, not the plumbing.

**Re-evaluate when:**
- A user hits a task where one context window/thread visibly underperforms (broad
  multi-target research, repo-wide audits, migrations).
- The Studio named-agent roster grows enough that "which roles to fan out to" becomes a
  real decision worth automating.

**Minimum-cost path if revisited:** Full design in `~/.claude/plans/purring-mixing-goose.md`.
P0 (MVP): add `orchestration` to `monadProfileSchema` + a `router` model role
(`packages/home/src/config.ts`, `packages/protocol/src/domain.ts`); new
`apps/monad/src/services/orchestration-router.ts`; minimal seam in `AgentLoop.runStream`/
`runBlock` (set a `turnOrchestration` flag → append `ORCHESTRATOR_INSTRUCTIONS` in
`buildPrompt` + raise `maxToolSteps`); emit an `agent.routing` event; wire in
`bootstrap/agent.ts`; unit + dual-transport e2e tests. single-mode behaviour is unchanged
(no schema migration needed — additive optional fields). P1 (parity): settings module +
`/v1/settings/orchestration` HTTP controller + web/CLI surface, following the `peer/`
three-file pattern. No reuse of the peer-federation network layer (this is purely
in-process); deterministic planner→workers→reviewer pipelines explicitly out of scope.

---

## Provider key rotation policies

**Status:** `parked`
**Discussed:** 2026-06-29

Allow a provider with multiple configured keys to choose an explicit credential rotation
policy instead of only using static priority ordering. Candidate policies include
round-robin distribution across eligible keys and priority fallback where higher-priority
keys are tried first, with lower-priority keys used only after quota/rate-limit/auth
failures.

**Why it came up:** Users may configure several keys for the same provider and want
different operational behaviour depending on intent: spread traffic across equivalent
keys, reserve backup keys for failure cases, or keep a preferred paid/team key ahead of
personal fallback keys.

**Why it's parked:**

- Current credential records already have `priority`, and the gateway can sort/use them
  without adding another policy surface.
- Correct rotation needs failure classification semantics (rate limit vs auth error vs
  transient provider error), observability, and persistence for round-robin cursors.
- The UX needs to make side effects clear: round robin can spend quota across all keys;
  fallback protects backup keys but may hide partial provider degradation.

**Re-evaluate when:**
- Users report rate-limit pressure or quota balancing needs on providers with multiple
  keys.
- Credential health reporting is rich enough to distinguish retryable provider failures
  from bad credentials.

**Minimum-cost path if revisited:** Add a provider-level `credentialPolicy`
(`priority-fallback` default, `round-robin` optional) plus a small per-provider rotation
state in daemon storage. Keep selection in the gateway, emit which credential id was
chosen and why, and add e2e coverage for rate-limit fallback and stable round-robin order.
