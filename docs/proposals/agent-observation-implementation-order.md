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

- **What:** define `ExternalAgentObservationEvent` in `@monad/protocol`: `kind`
  (`message`/`reasoning`/`tool-call`/`tool-result`/`turn-start`/`turn-end`/`error`/`system`), structured
  `tool` (`{name,input?,output?}`), `streaming: boolean`, `text?`, `raw`, `at?`. **UI-agnostic** — no
  roles, no pre-formatted `"Tool call X"`, no `providerEventType` passthrough.
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
  **Delete** the client resolver singleton + `classifyNativeCliActivity` + client
  `nativeCliEventsAreGenerating` re-derivation. Remove the old dual-emit path from P2.
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
  roster capability); **session** = a conversation instance that binds members. Rename the monad chat
  session concept + its endpoints to *chat session*. Decide the id scheme (`ses_…` scoped under `prj_…`
  vs a distinct prefix) and re-key the session `stream`/`ui-stream` off `prj_…`.
- **Depends:** P0. **Ships green:** one implicit session per project preserves current behavior while the
  model generalizes. **Size:** large (data model + endpoints + client).
- **Note:** doing this *after* Track A means Track A's observation planes (per-`agentId`) don't re-key —
  only the session-level `events`/`ui-stream` re-key here, which is B's job regardless.

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

## Open decisions gating a start

- Neutral-event `kind` set + whether `tool_call`/`tool_result` leave the runtime `…OutputEvent` for the
  observation events (per the layering proposal's Open questions).
- Wire shape of `raw` (provider-raw vs domain event) — decide before P3.
- Rendering-library packaging (`@monad/sdk-experience` vs `@monad/atoms` subpath) — decide before P4.
- B's id scheme + chat-session endpoint rename scheme — decide before P6.
