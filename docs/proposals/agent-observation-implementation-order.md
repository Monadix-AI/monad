# Implementation order: external-agent observation + project/session

Status: draft · Companion to [agent-adapter-observation-layering.md](agent-adapter-observation-layering.md).
Sequences the work into phases. **Every phase leaves the tree green and shippable** (own PR). Two tracks
share one foundation (P0) and are otherwise independent:

- **Track A — observation architecture** (P1–P5): fixes the current bugs + the layering mess. Higher
  priority.
- **Track B — project ↔ session decoupling** (P6–P7): a product feature (multi-session). Independent of
  A after P0; can parallelize if there's capacity, otherwise follows A.

```
P0 rename ─┬─► P1 schema ─► P2 adapter-decode ─► P3 split-stream ─► P4 experience-render ─► P5 generalize   (Track A)
           └─► P6 session-entity ─► P7 multi-session-lifecycle                                              (Track B)
```

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
  The rendering lib lands in **`@monad/sdk-atom-client-rtk`** (the experience SDK; client React) — extract
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
- **Packaging** — schema→protocol, decode→adapter, rendering+hooks→`@monad/sdk-atom-client-rtk`,
  `@monad/sdk-atom` stays pure. ✅
- **B storage + ids** — one `sessions` table, nullable `projectId`, `session_members` join, single
  `ses_…`. ✅
- **Endpoint scheme** — create/list scoped under `agents`/`projects`; access flat under `/sessions/:sid`
  with agent streams one level down. ✅

Remaining: `usageMeter`/history plane detail (schema); whether the old `prj_…` routes get a deprecation
alias during P6.
