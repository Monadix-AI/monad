# Proposal: raw/ui two-plane streaming; adapter decodes to neutral events, experience renders

Status: draft · Scope: design only (no implementation yet)

## Problem

The agent-adapter contract mixes two responsibilities and leaks a UI model. Today an adapter carries:

1. **Runtime plumbing** — launch/communicate with a 3rd-party agent + decode the minimal events the
   daemon *acts on* (`agent_message`, `approval_requested`, `session_ref`, `connection_required`,
   `provider_error`, …). The daemon can't route/gate/persist on raw bytes, so this stays in the adapter.
2. **Observation projection to monad's UI model** — `observation: NativeCliObservationProjector`
   (per-provider `recordProjectors`, `classifyActivity`, `isStreamingFragment`, …): raw provider output
   → `NativeCliObservationEvent`, which is **monad's observation-UI data model** (roles, pre-formatted
   `text` like `"Tool call ${name}"`, `providerEventType` passthrough), not a neutral contract.

The bug isn't "the adapter decodes" — decoding raw provider output *is* the adapter's value (the unified
contract). The bug is **the adapter decodes straight into monad's UI shape and leaks provider event
strings**:

- A different experience (graph view, metrics dashboard) can't reuse it — it's monad-UI-shaped.
- `classifyActivity` / `isStreamingFragment` exist only because the adapter leaked a raw
  `providerEventType` that consumers then *re-classify*. Bake `kind`/`streaming` into a neutral event at
  decode time and the patches vanish.
- The observation SSE conflates planes in one frame (raw `append` **and** projected `events`), forcing
  clients to re-derive on `append` frames — the root of a class of recent bugs.

**Fix:** the adapter decodes to a **neutral, UI-agnostic** event schema (or passes raw through); the
**experience** renders neutral events into cards. Split the observation stream into a raw plane and a
neutral-projected plane. Generalize the whole thing off "native-cli" to any external agent.

## Sessions: chat session vs project session (and the project environment)

A **session** is the *conversation entity* — one user↔agent(s) exchange with its own message log. It
comes in **two parallel kinds that sit side by side, not nested**:

- **chat session** — a standalone user↔monad-agent conversation. This is the current `ses_…`
  ("monad session") **renamed to *chat session***; its endpoints rename accordingly (see below).
- **project session** — a conversation inside a **project** environment. A **project** is an
  *environment* (cwd, member-agent roster, config/workspace), not a conversation; the relation is
  **one project → N project-sessions**. In the simplified design a project had exactly one implicit
  conversation, so `prj_…` doubled as the transcript target — that coupling is what this splits.

Both kinds are *sessions* and share the raw/ui two-plane streaming contract **uniformly** — the
`session` row in the grid below covers either kind, and observation is per-agent within either.

Consequences:

- **The conversation two-plane (`stream` / `ui-stream`) is keyed by a `session`, never by a project.**
  A project has no conversation stream — it's the scope holding project-sessions (and their
  members/env). Chat sessions are already `ses_…`-keyed (fine; only the *name* changes). Today's
  `prj_…`-keyed `events`/`ui-stream` are really the single coupled project-session; as it decouples,
  those become project-session-keyed and `prj_…` is the environment scope above them.
- **Endpoints rename:** the paths/handlers/client methods that today say "session" and mean the monad
  chat session move to *chat session* naming, so "session" can be the abstract concept shared by both
  kinds. The exact path scheme (`/chat-sessions/:id` vs keeping `/sessions/:id` documented as chat
  session) is an implementation call — see Open questions.
- The fuller project↔session decoupling is its own work item, but the stream contract below should be
  **session-keyed from the start** so it needs no second migration.

## Observation is per-agent, for ANY agent kind

Observation is not native-cli-specific — it is "one agent's raw activity + optional projection", and it
applies to **any** agent in a session: a native-CLI process, an ACP agent, or monad's own built-in
agent. The raw *source* differs by kind, the plane is uniform:

- **external-agent (native-CLI, ACP, …):** raw = the provider's own output stream.
- **monad's built-in agent:** raw = its own domain events (`agent.token`/`agent.reasoning`/`tool.called`)
  — no external decode needed.

**Migration: rename `NativeCli*` → `ExternalAgent*`** across protocol / daemon / atoms / client.
"native-cli" becomes *one kind* of external agent, not the whole abstraction. The adapter contract, the
observation streams, and the ids all generalize to external-agent.

**A chat session needs no separate observation.** It is 1:1 (one agent), so filtering the session to
"that agent" is the whole session — `observation ≡ the chat session's own stream / ui-stream`. Only
multi-agent sessions (project sessions) actually slice per agent.

## The model: a raw/ui two-plane grid over session + observation

| | **`stream` (raw)** | **`ui-stream` (projected)** |
|---|---|---|
| **session** (a project's multi-agent conversation) | full merged log: member agents' raw + user/session events, wrapped in monad metadata (token deltas kept) | transcript `UIItem`s (`SessionUiProjector` aggregates to transcript level; monad first-party) |
| **observation** (one `agentId`; multi-agent sessions only) | that agent's pure raw (envelope stripped) | that agent's normalized activity events (provider projector) |

**Source direction & granularity (important — raw is never coarsened).** The atomic source is
**per-agent raw**; `session.stream` is the full merged log (each agent's raw + user/session events) and
`observation.stream(agentId)` is one agent's slice of it — which is why "observation = filter session"
holds. **Raw frames are structured delta records** (`{kind:'delta', text}`), not byte chunks, and token
deltas are **kept** (streaming render needs them). No coarsening happens at the raw-stream level.

The transcript-vs-observation granularity difference lives entirely in the **ui projection**, and
fan-out is handled there, not by mutilating the source:

- `session.ui-stream`'s projector emits **transcript-level** events (streaming reply messages + tool-card
  lifecycle); it does **not** re-broadcast each agent's internal thinking/tool tokens as transcript
  updates — they collapse into card state. This server-side aggregation is what keeps the broad
  transcript audience light.
- `observation.ui-stream`'s projector emits the **full per-agent detail**, scoped to whoever opened that
  panel.
- The raw `session.stream` firehose carries everything but has a **narrow, opted-in** audience (3rd
  parties / debuggers); broad transcript viewers subscribe to `ui-stream`, not raw. So no plane needs to
  drop token deltas — the two realtime-channels fan-out levers are (a) the server aggregates in the ui
  projection and (b) broad viewers subscribe to the projected plane.

## The projector splits into two homes (the key decision)

"Projector" (`stream` → `ui-stream`) is really **two** stages that belong to different layers:

| stage | job | home |
|---|---|---|
| **raw → normalized events** (the `ui-stream` payload) | provider-protocol decode: emit `kind` / structured `tool` / `streaming` — a **neutral, UI-agnostic, protocol-defined** event | **external-agent adapter, OPTIONAL.** Absent → **`ui-stream` ≡ `stream`** |
| **normalized events → cards / DOM** | thinking cards, tool timeline, sheen, layout | **experience, always** |

The load-bearing rule: **the `ui-stream` payload is a neutral protocol schema, not monad's UI model.**
That single constraint is what lets the decode live in the adapter without re-coupling it to monad's UI
— it emits events any experience can render. `classifyActivity` / `isStreamingFragment` are **not moved
elsewhere; they are subsumed** into the neutral event's `kind` / `streaming` fields, produced once by
each provider's decoder at decode time (which also confines all provider vocab —
`turn/completed`/`result`/`content_block_delta` — inside that one decoder, killing the shared pile).

The **session `ui-stream`** (transcript) is the one exception that stays a monad-first-party UI model
(`SessionUiProjector`) — it's monad's app shell, not a neutral contract, and that's fine.

## What already exists vs. what changes

- `session.stream` = existing `GET …/events` (`streamEvents`, raw domain `Event`s). Shape unchanged;
  chat session already keyed right (only the concept renames), project session moves off `prj_…` on
  decouple.
- `session.ui-stream` = existing `GET …/ui-stream` (`streamUiEvents`, `SessionUiProjector`). Stays
  monad first-party.
- `observation.stream` / `observation.ui-stream` = the change: split today's combined
  `NativeCliObservationAccessResponse` into two planes, per `agentId`; the `ui-stream` payload becomes
  the neutral normalized-event schema (or ≡ raw when the adapter has no projector).

## Layering after this change

```
external-agent adapter (sdk-atom)  transport + runtime decode (events the daemon acts on) + raw passthrough
                                   + OPTIONAL raw→neutral observation projector (absent → ui-stream ≡ stream)

protocol                           the neutral observation-event schema (kind / tool / streaming) — the
                                   UI-agnostic contract both the adapter emits and experiences render

experience                         neutral events → cards / DOM (observation panel); the session transcript UI
```

- **Runtime vs UI litmus:** does the daemon runtime act on it? → adapter runtime decode. Provider
  wire → neutral events? → adapter's optional projector. Neutral → pixels? → experience.
- **3rd party:** subscribe to `raw` and render your own way, OR subscribe to the neutral `ui-stream`
  and render it differently from monad. `raw` is the ground truth and escape hatch.

## Connection model

**Four independent endpoints, one per (target × plane). Reuse rides HTTP/2, not frame multiplexing.**

- Keep the existing pattern: `events` and `ui-stream` are already separate endpoints. Observation gets
  the same two.
- HTTP/2 is already required (realtime-channels constraint 3: HTTP/1.1 caps 6 conns/origin). Under h2,
  N SSE streams multiplex over one TCP — the connection count is a non-issue.
- A consumer subscribes to the **one plane it needs** (transcript UI → `ui-stream`; 3rd party → `raw`;
  observation panel → observation `ui-stream`). Wanting both planes at once is rare, and since `ui` is
  derived from `raw`, it's served by two cheap h2 streams.
- **No frame-level multiplexing** (one SSE carrying raw+ui tagged by channel): it adds dual resume
  cursors + demux for a rare case h2 already handles. Each plane keeps its own `last-event-id` resume.

## What changes vs. gets deleted

- **Delete** `classifyActivity` / `isStreamingFragment` as separate contract methods and the 6
  declarations — subsumed into the neutral event's `kind` / `streaming` fields the adapter's projector
  emits.
- **Delete** the UI-flavored production inside the adapter (the `"Tool call ${name}"` text, roles, the
  `NativeCliObservationEvent` shape) — the UI flavoring moves to experience rendering. The adapter's
  projector keeps only the *decode* (raw → neutral events).
- **Delete** the combined `NativeCliObservationAccessResponse` (split into raw / neutral-ui) and the
  client-side re-classification + resolver singleton (`classifyNativeCliActivity`, client
  `nativeCliEventsAreGenerating`) — consumers read the neutral `ui-stream` or `raw`.
- **Keep, generalized:** the adapter's observation projector (now optional, emitting neutral events,
  renamed to external-agent).

## Consequences / simplifications

- **Delta-bug gone.** A consumer picks one plane end-to-end: `ui-stream` is neutral-projected per frame
  (server or adapter, consistently), `raw` is rendered wholesale by the consumer. No hybrid.
- **Provider vocab confined** to each external-agent's own decoder; the mixed
  `turn/completed`+`result`+`content_block_delta` pile disappears.
- **One raw source per agent.** `observation.stream(agentId)` is the fine-grained slice; the standalone
  observation hub becomes redundant with the per-agent source and can later be retired.

## Migration phases

1. **Rename `NativeCli*` → `ExternalAgent*`** (protocol / daemon / atoms / client). Mechanical but
   wide; do it first so everything below lands on the general name.
2. **Define the neutral observation-event schema** in `@monad/protocol` (`kind` / structured `tool` /
   `streaming` / raw). This is the `ui-stream` payload and the render contract.
3. **Adapter projector → neutral, optional.** Change each external-agent's projector to emit the neutral
   schema (folding in kind/streaming); drop the UI-flavored `NativeCliObservationEvent` production.
   Absent projector → `ui-stream` ≡ `stream`.
4. **Split observation into two planes** (`observation.stream` raw / `observation.ui-stream` neutral),
   per `agentId`.
5. **Move rendering to experience:** neutral events → cards/timeline in the observation experience;
   delete the client re-classification.
6. **Generalize observation to all agent kinds** (external-agent + monad's built-in agent); confirm the
   chat-session-is-its-own-observation identity holds.
7. **(optional)** derive `observation.stream` from the per-agent source and retire the hub.

## Related: project↔session decoupling (separate proposal)

This streaming contract depends on only two conclusions from that work — "streams are session-keyed"
and "chat session / project session are parallel kinds". The rest is its own proposal:

- **Sessions are concurrent** within a project (not one-active).
- Lifecycle verbs: `create` / `delete` / `archive` (no others identified yet).
- **Members are per-session** — different sessions in one project may have different member agents /
  people.
- UI: a **session tab** strip within a project.
- Data model: project = environment (cwd, config, member roster capability); session = conversation
  instance that binds some members; ids (`ses_…` under a `prj_…` vs a distinct prefix — TBD there).

## Open questions

- **Exact wire shape of `raw`.** Provider-raw chunk vs the runtime `agent.output`-style domain event.
  Leaning: `session.stream` stays domain events (raw chunk carried inside); `observation.stream` strips
  to the pure provider output for that agent. Confirm 3rd-party consumers key off provider-raw.
- **`tool_call` / `tool_result` in the runtime `ExternalAgentOutputEvent`.** If the daemon doesn't act
  on the agent's own tool calls (provider-owned tools), they're observation-only and belong to the
  neutral observation events, not the runtime contract — shrinking what the adapter must decode for the
  daemon.
- **`usageMeter` + history pages** follow the same 2×2 (raw / projected, project / observation) and must
  offer the same plane split so history and live stay symmetric.
- **Chat-session endpoint rename scheme.** Rename the paths/handlers/client methods (`/sessions/:id/*`,
  `streamEvents`/`streamUiEvents`, `session.*` RPC) to *chat session*, or keep the paths and only
  re-document "session" → "chat session"? And the **project-session id scheme** — reuse `ses_…` scoped
  under a `prj_…`, or a distinct prefix — needs a call in the project↔session decoupling work.
- **Packaging** of monad's observation **rendering** library (neutral events → cards): `@monad/sdk-experience`
  vs a `@monad/atoms` subpath. Must be browser-safe and importable by 3rd-party experiences that want to
  reuse monad's cards, without the node-only adapter runtime. (The neutral event *schema* is in
  `@monad/protocol`; the adapter's decode ships with the adapter.)
- **Persistence** stores `outputSnapshot` (raw); projected events are derived per read — so no stored-
  data migration. Confirm no consumer persists projected events.
