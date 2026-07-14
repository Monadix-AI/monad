# Implementation order: external-agent observation + project/session

Status: **largely implemented** — Track A shipped (2026-07-07), P5a (monad built-in agent) shipped (2026-07-09), Track B P6/P7 shipped (`session_members` store/protocol, session-under-project creation, member templates + per-session invite/spawn); remaining: **P5b (ACP-agent observation)** · Companion to
[agent-adapter-observation-layering.md](agent-adapter-observation-layering.md). Sequences the work into
phases. **Every phase leaves the tree green and shippable** (own PR). Two tracks share one foundation
(P0) and are otherwise independent:

- **Track A — observation architecture** (P1–P5): fixes the current bugs + the layering mess. Higher
  priority.
- **Track B — project ↔ session decoupling** (P6–P7): a product feature (multi-session). Independent of
  A after P0; can parallelize if there's capacity, otherwise follows A.

```
P0 rename ─┬─► P1 schema ─► P2 adapter-decode ─► P3 split-stream ─► P4 experience-render ─► P5 generalize   (Track A)
           └─► P6 session-entity ─► P7 multi-session-lifecycle                                              (Track B)
```

## As shipped — Track A (all merged to `main`)

| Phase | Commit | Notes vs. plan |
| --- | --- | --- |
| P0 rename | `c01a5786c` | + one-line follow-up `15ea996aa` — the sed missed the bare `newId('ncli')` prefix, so sessions minted `ncli_…` against `/^exa_/` schemas. Caught by e2e, not the unit-only gate. |
| P1 schema | `fb6302311` | Named **`AgentObservationEvent`** (agent-kind-neutral), **not** `ExternalAgentObservationEvent` — it generalizes to any agent kind and avoids clashing with the legacy UI-flavored type. |
| P2 decode | `8db7cd877` | `toAgentObservationEvent` (legacy→neutral) in `@monad/atoms`, reusing each adapter's `classifyActivity`/`isStreamingFragment`. Later tweak: keeps `text` on `turn-end` (codex `result`). |
| P3 two-plane | `ce50c53e5` | `externalAgentUiObservationFrameSchema` + `observeUi`/`subscribeUiObservation` + `GET /external-agent-sessions/:id/ui-observation{,-stream}`. Kept the current endpoint keying; the `/sessions/:sid/agents/:agentId` path restructure is deferred to Track B. |
| P4a consumer | `6be0be018` | client + client-rtk + sdk-atom-client-rtk ui-stream consumer. |
| P4b render | `4c9970d45` | Panel renders neutral cards. **Decision:** ui-stream returns a *generic* `tool`; "which tool → which card" stays UI business (no server enrichment). Rich cards still extract from `raw` (neutral preserves it). |
| P4c panel-on-ui-stream | `2c99afe89` | Panel's session observation moved to the ui-stream → **retires the client-side delta re-derivation = the delta-bug fix.** Deliveries keep the poll + legacy path. |
| P5a monad built-in agent | *(this branch)* | Unblocked by Track B landing (`session_members`, `type: 'monad'`). Scoped to the monad built-in agent only — **ACP agents are explicitly out of scope for this pass** (P5b, still open — see below). |

### P5a — monad built-in agent (this branch)

- **What:** the daemon's own agent-loop turn (`user.message` / `agent.token` / `agent.reasoning` /
  `agent.message` / `agent.error` / `tool.called` / `tool.progress` / `tool.result`, plus the
  publish-only `session.stream_started`/`session.stream_ended` turn-boundary markers) is now mapped to
  the neutral `AgentObservationEvent` plane, the same one external-agent adapters already emit. No new
  raw decode was needed — monad's own domain `Event`s are already structured, so this is a field reshape
  (`toAgentObservationEvent` in `apps/monad/src/agent/observation.ts`), not a parser, confirming the
  "session raw = domain events" decision in the layering proposal.
- **Member scoping:** a session's domain-event log is the *merged* log for every member (per the layering
  doc); a `monad`-typed `session_members` row's own observation is the log filtered to events with no
  `externalAgentSessionId`/`deliveryId` tag (`isMonadAgentDomainEvent`) — those belong to a different,
  bridged member. ACP-delegated tool events (`forward-acp.ts`, `acp-channel-delegation.ts`) carry neither
  tag today, so they are **not yet distinguishable from the monad member's own tool calls** — one of the
  reasons ACP generalization (P5b) is deferred rather than folded in here.
- **Plane wiring:** no `externalAgentSessionId` exists for a `monad` member, so it can't ride
  `/external-agent-sessions/:id/ui-observation`. Added the session-member counterpart instead:
  `GET /sessions/:id/members/:memberId/ui-observation{,-stream}` (http-only, same pattern as the
  external-agent routes — see `apps/monad/src/transports/http/sessions/controller.ts`), backed by
  `createSessionMemberObservationHandlers` (`apps/monad/src/handlers/session/handlers/
  session-member-observation.ts`) and a new `SessionMemberUiObservationFrame` schema in
  `@monad/protocol`. The GET snapshot merges persisted history (`store.listEvents`) with the active
  round's un-persisted tail (`RoundCache`, since `agent.token`/`agent.reasoning` are bus-only); the SSE
  stream layers a `bus.subscribe` filter+map on top, so a `history`-state member can still start streaming
  once a fresh turn begins (unlike the external-agent SSE, which force-closes on any non-`live` frame).
- **Explicitly not built:** observation-card rendering for these events (separate, already-deferred task)
  and any ACP wiring (P5b below).

### Deviations & open follow-ups

- **Classifiers NOT deleted** (plan said delete): `externalAgentEventsAreGenerating` /
  `classifyExternalAgentActivity` are load-bearing — the daemon uses the former server-side
  (`ui-projection-helpers.ts`) and both drive avatar presence. Left intact.
- **Legacy raw observation *stream* is now dead code** (the panel moved off it in P4c) but not yet
  removed — `MonadClient.streamExternalAgentObservation` + `external-agent-observation-fold` + the
  `streamExternalAgentObservation` RTK endpoint/hook + re-exports, plus the daemon
  `/external-agent-sessions/:id/observation-stream` route and its handler/transport SSE helper. knip
  won't flag it (public API). Tracked as a separate cleanup.
- **P4b/P4c were verified by typecheck + the observation test suite, not a running panel.** Only
  visible change expected: the source badge shows the coarser `provider` (e.g. `codex`) instead of the
  fine-grained source. Worth an eyes-on pass.
- **P5 split into P5a (monad built-in agent, done — see above) and P5b (ACP agents, still open).** It was
  gated on Track B, not independent: the monad built-in agent was already observable via its own session
  transcript, and only needed the *neutral* plane once it could appear as a member in a project's
  observation panel — which needed the project→session→members model (Track B). Now that P5a is done,
  **ACP agents are still not a first-class observable project member**: they have no `session_members`
  row today (channel/editor-bridged, not member-modeled), no `externalAgentSessionId`, and their
  `tool.called`/`tool.result` events (routed via `forward-acp.ts`/`acp-channel-delegation.ts`) aren't
  tagged the way a bridged external-agent member's events are — `isMonadAgentDomainEvent`
  (`apps/monad/src/agent/observation.ts`) would currently misattribute an ACP agent's tool activity to
  the monad member. Generalizing P5b needs: (1) an ACP-typed `session_members` row/identity, (2) a
  disambiguating tag on ACP-originated domain events (mirroring `externalAgentSessionId`/`deliveryId`),
  and (3) the equivalent `observeMemberUi`/`subscribeMemberUiObservation` branch for that member type.
  Not implemented in this pass — left for a follow-up.

## P0 — Rename `NativeCli*` → `ExternalAgent*`  (foundation, do first)

- **What:** mechanical rename across `@monad/protocol` / daemon / `@monad/atoms` / client — types, ids,
  endpoints, methods. "native-cli" becomes *one kind* of external agent.
- **Why first:** every phase below references the general name; renaming once up front keeps later diffs
  semantic, not noise.
- **Depends:** nothing. **Ships green:** pure rename, existing tests prove it. **Size:** wide but shallow;
  its own PR, no behavior change.
- **Risk:** merge churn only. Land it before other in-flight work rebases.

---

## Track A — observation architecture

### P1 — Neutral observation-event schema (protocol)

- **What:** define `ExternalAgentObservationEvent` in `@monad/protocol`. `kind` (kebab enum):
  `turn-start | user-message | reasoning | tool-call | tool-result | assistant-message | turn-end`.
  Plus `streaming: boolean`, `text?`, structured `tool?: {name,input?,output?}`, `raw`, `at?`.
  `turn-end` carries `reason` (`completed|aborted|error|length|content-filter`). A separate `usage` frame
  for rate-limit/tokens. **No `error`/`system` kind** — system/transport failure is signalled by stream
  termination (`onError`/terminal frame), not an in-band event. **UI-agnostic** — no roles, no
  pre-formatted text, no `providerEventType`.
- **Also shrink the runtime event:** move `tool_call`/`tool_result`/`web_search_result` out of
  `ExternalAgentOutputEvent` (daemon doesn't act on them) into the neutral observation events.
- **Why:** the single contract both the adapter emits and every experience renders. Everything after
  keys off it.
- **Depends:** P0. **Ships green:** additive (no consumers yet). **Size:** small.

### P2 — Adapters decode raw → neutral events

- **What:** each external-agent's projector emits `ExternalAgentObservationEvent` (provider vocab —
  `turn/completed`/`result`/`content_block_delta` — confined inside that one decoder; `kind`/`streaming`
  produced here). **Delete** `classifyActivity` / `isStreamingFragment` (subsumed) and the UI-flavored
  `NativeCliObservationEvent` production.
- **De-risk:** dual-emit — keep the old projected shape alongside the neutral one until P4 switches
  consumers, so nothing breaks mid-flight.
- **Depends:** P1. **Ships green:** old path still serves the panel; new path unused yet. **Size:** medium
  (6 decoders + shared classifier removal).

### P3 — Split the observation stream into two planes

- **What:** replace the combined `…ObservationAccessResponse` (raw + projected + usage in one frame) with
  `observation.stream` (raw, per `agentId`) and `observation.ui-stream` (neutral events, projected every
  frame incl. deltas). Retire the client-side delta re-derivation.
- **Why:** this is the frame that **fixes the delta-bug** (one plane end-to-end, no server-half/client-half
  hybrid).
- **Depends:** P2. **Ships green:** the panel can move to `ui-stream` in the same PR or P4. **Size:** medium.

### P4 — Move rendering to experience; delete client re-classification

- **What:** the observation experience renders `ExternalAgentObservationEvent[]` → cards/timeline/sheen.
  The rendering lib lands in the experience SDK's React half (**`@monad/sdk-experience/react`**) — extract
  any experience-facing types out of `@monad/sdk-atom` (which stays a pure adapter contract) at the same
  time. **Delete** the client resolver singleton + `classifyNativeCliActivity` + client
  `nativeCliEventsAreGenerating`. Remove the P2 dual-emit path.
- **Depends:** P2, P3. **Ships green:** panel now on the neutral plane. **Size:** medium (UI move + deletes).

### P5 — Generalize observation to every agent kind + unified agent identity

- **What:** observation applies to monad's built-in agent (raw = its own domain events) and ACP agents,
  not just external CLIs. Requires a **stable, uniform `agentId`** within a session (point 3). Confirm
  the *chat-session-is-its-own-observation* identity (1:1 needs no slice).
- **Depends:** P1–P4. **Ships green:** external agents already work; this adds the other kinds. **Size:**
  medium.
- **Status: P5a (monad built-in agent) shipped** — see "As shipped" above. **P5b (ACP agents) still
  open** — deferred to a follow-up (see Deviations).

---

## Track B — project ↔ session decoupling

Needs its own proposal (only sketched here). Depends only on P0; the streaming contract already assumes
its two conclusions ("streams are session-keyed", "chat session / project session are parallel kinds").

### P6 — Session as a first-class entity under project

- **What:** split the coupled `prj_…`-as-conversation. **project** = environment (cwd, config, member
  roster capability); **session** = a conversation instance that binds members. One `sessions` table with
  nullable `projectId` + a `session_members` join table (empty for chat); single `ses_…` id for both
  kinds. Endpoints: `POST/GET /agents/:aid/sessions` and `/projects/:pid/sessions` (create/list),
  `/sessions/:sid/{stream,ui-stream,messages}` + `/sessions/:sid/agents/:agentId/{stream,ui-stream}`
  (access, flat). Rename the monad chat-session concept accordingly.
- **Depends:** P0. **Ships green:** one implicit session per project preserves current behavior while the
  model generalizes. **Size:** large (data model + endpoints + client).
- **Note:** doing this *after* Track A means Track A's per-`agentId` planes don't re-key — only the
  session-level streams re-key here, which is B's job regardless.

### P7 — Multi-session lifecycle + UI

- **What:** concurrent sessions per project; `create` / `delete` / `archive`; **members per session**
  (different sessions may bind different agents/people); a **session-tab** strip in the project UI.
- **Depends:** P6. **Ships green:** additive over P6's model. **Size:** large (backend lifecycle + web UI).

---

## Recommended sequence

1. **P0** (rename) — unblocks everything, land first.
2. **P1 → P5** (Track A) — the architecture fix + bug kills; this is the payoff for the whole discussion.
3. **P6 → P7** (Track B) — the multi-session product feature; parallelizable after P0 if staffed, else
   after A.

## Gating decisions — resolved (see layering proposal → Resolved decisions)

- **Neutral `kind` set + runtime shrink** — set fixed above; `tool_call`/`tool_result`/`web_search_result`
  leave the runtime event. ✅
- **`raw` shape** — session raw = domain events; agent raw = provider-raw (stripped). ✅
- **Packaging** — schema→protocol, decode→adapter, hooks + rendering→the experience SDK,
  `@monad/sdk-atom` stays pure. ✅ The experience SDK is now **one package, `@monad/sdk-experience`,
  split by subpath on the React boundary**: the root is the React-free contract (types + event
  bridge, extracted from `@monad/sdk-atom`) and `@monad/sdk-experience/react` holds the RTK hooks
  (the former `@monad/sdk-atom-client-rtk`, now folded in). The observation-card *rendering*
  library that would live alongside those hooks remains open.
- **B storage + ids** — one `sessions` table, nullable `projectId`, `session_members` join, single
  `ses_…`. ✅
- **Endpoint scheme** — create/list scoped under `agents`/`projects`; access flat under `/sessions/:sid`
  with agent streams one level down. ✅

Remaining: `usageMeter`/history plane detail (schema); whether the old `prj_…` routes get a deprecation
alias during P6.
