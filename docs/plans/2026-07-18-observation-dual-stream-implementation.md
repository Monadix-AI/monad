# Observation Dual Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy UI observation API with two provider-sourced planes — a **raw** plane that delivers unmodified provider records (`data: unknown`) and a **convenience** plane that delivers Monad-neutral `AgentObservationEvent` upserts with full raw provenance — each with distinct live and history APIs, driven by explicit external-agent connection lifecycle.

**Source design:** [`2026-07-18-chat-experience-realtime-planes-design.md`](./2026-07-18-chat-experience-realtime-planes-design.md), Plane 2B + Observation-panel state machine. This plan implements design migration steps 5–8. Do not diverge from the design's contracts; where this plan and the design disagree, the design wins.

**Tech Stack:** Bun, TypeScript, Zod, Elysia SSE + JSON-RPC control transport, RTK Query, React.

---

## Current state (verified against `main`, 2026-07-18)

The observation baseline (design §Baseline) is already partly in place, but the **raw plane does not yet exist**; today's "raw" surface actually ships normalized events. What exists:

- **Neutral event `AgentObservationEvent`** — `packages/protocol/src/agent-observation.ts` (re-exported via `external-agent-observation.ts:3`).
- **`ExternalAgentObservationEvent` is NOT provider-native raw** — `external-agent-observation-event.ts:12`. It carries `id`/`dedupeKey`/`projection`/`role`/`text`/`source`/`providerEventType`/`diagnostic` and nests the true provider bytes only inside `provenance.rawEvents: unknown[]` (`:8-10`). It is a *normalized* event produced by `projectLive()`. **The plan must introduce a genuinely raw contract (`data: unknown`); it cannot treat `ExternalAgentObservationEvent` as raw.**
- **`readPage()` returns projected events, not raw** — `packages/atoms/src/agent-adapters/event-source.ts:253` (`createOutputHistoryEventSource`) calls `source.projectLive({ …, mode:'history' })` then paginates the *projected* events; `createAppServerHistoryEventSource:289` projects a provider page before returning. So provider-native history acquisition and projection are currently fused and must be **split** (design §Raw contract: "An adapter must not return normalized observation events from its acquisition method").
- **Existing mixed schemas** — raw-ish access `externalAgentObservationAccessResponseSchema:86` (streams `output`/`append` bytes + server-normalized `events` + `usageMeter`) and UI `externalAgentUiObservationFrameSchema:136` (full neutral list every frame). Both are replaced.
- **Adapter contract** — `ExternalAgentEventSource` (`packages/sdk-atom/src/agent-adapter.ts:313`): `projectLive()` + optional `readPage()` (`ExternalAgentEventPageResult`). Split acquisition (raw) from projection here.
- **Resolver / hub / host** — `ExternalAgentObservationResolver.observe`/`observeUi` (`observation-resolve.ts:32`); `ExternalAgentObservationHub` (`observation-hub.ts:14`, tracks `{ epoch, seq }`); `host.observeWithProviderHistory`/`observeUiWithProviderHistory` (`host/index.ts`).
- **Ephemeral live raw store** — `services/external-agent/live-raw-store.ts` (per-`{sessionId}-{epoch}.sqlite`, deleted on close); provider-history paging: `host/history-backfill.ts` + `host/history-cursor.ts`. This is the design's `LiveRawStore` visibility cache — reuse it, do not add a durable journal.
- **Output snapshot fallback (to be removed)** — `EXTERNAL_AGENT_OUTPUT_SNAPSHOT_MAX = 256 * 1024` (`external-agent-observation.ts:84`).

Current HTTP routes (all replaced, no aliases — design §Plane 2B):
- `GET /external-agent-sessions/:id/observation` (`external-agent.ts:170`)
- `GET /external-agent-sessions/:id/ui-observation` (`:180`), `.../ui-observation-stream` (`:190`)
- `GET /native-agent-deliveries/:id/observation` (`:210`)
- `GET /sessions/:id/members/:memberId/ui-observation[-stream]` (`transports/http/sessions/controller.ts:476,492`) — session-member twins.

Client/RTK today: `MonadClient.streamExternalAgentUiObservation` (`packages/client/src/index.ts:333`); RTK `stream-external-agent-ui-observation.ts`, `get-external-agent-observation.ts`, `get-external-agent-history-page.ts`.

### Cross-plane seams (coordinate with the Message Event Plane plan)
- **Consume, do not redefine:** `external_agent.session.connection.opened` / `.closed` (with `observationEpoch` — design §Provider connection notification, lines 214–227) are defined in the Message Event Plane plan (Task 1) / the source design's event taxonomy. This plan's Task 5 consumes them.
- **Removal ordering:** the Message Event Plane plan removes `external_agent.output` from the global bus, but only after raw output moves to this plane's raw SSE (design line 171, migration step order 5→3). This plane's raw stream (Task 4) must land before that removal.

---

## Global Constraints

- Raw is raw: the raw plane emits `ExternalAgentRawFrame.data` verbatim (exact accepted string frame for live text transports; exact provider record for history), **before** `parseOutput` / `projectLive` / merge / dedupe / neutral conversion. Monad may add routing/ordering metadata only.
- Convenience is a projection of the same committed raw frame — never a second acquisition path. Convenience frames are incremental `upsert`/`remove`, not a full list per tick. Each carries complete raw provenance.
- Raw endpoints are privileged diagnostic surfaces: resource-scoped auth, never log raw payloads wholesale.
- No durable observation journal and no `output` snapshot fallback — remove `EXTERNAL_AGENT_OUTPUT_SNAPSHOT_MAX` and the `output`/`append` byte-snapshot path. After the live epoch ends, Monad is strictly equal to provider-native history (`coverage: 'exact' | 'settled'`).
- No compatibility aliases for legacy UI observation APIs (`ui-observation`, `ui-observation-stream`, `observeUi`, `streamExternalAgentUiObservation`).
- Each daemon behavior matches over TCP loopback and Unix transport. HTTP SSE is a web transport, not the domain contract: the shared subscribe/history handler is exercised as a domain unit, and the Unix/JSON-RPC control transport exposes the same subscribe/history via `rpc/method-table.ts`; HTTP SSE framing is tested separately.
- Write each regression test first and observe the expected failure. Adapter projection tests assert an exact `toEqual` contract on the projected page, not a bare snapshot-exists check (repo test rules).
- `@monad/protocol` is the only wire-contract source; parse at the boundary, never cast.

---

### Task 1: Raw and convenience protocol contracts (four shapes)

**Files:**
- Modify: `packages/sdk-atom/src/agent-adapter.ts` — split `ExternalAgentEventSource` into a raw acquisition method + a projector; add `ExternalAgentRawHistoryPage`/`ExternalAgentRawHistoryRecord`.
- Modify: `packages/protocol/src/external-agent/external-agent-observation.ts` and `external-agent-observation-event.ts`
- Reference (do not redefine): `packages/protocol/src/agent-observation.ts` (`AgentObservationEvent`); connection lifecycle event schemas (owned by the Message Event Plane plan).
- Modify: `packages/protocol/src/external-agent/index.ts` + `packages/protocol/src/index.ts` barrels
- Test: `packages/protocol/test/unit/external-agent-observation.test.ts`

**Interfaces (from design §Plane 2B):**
- `externalAgentRawFrameSchema` → `{ externalAgentSessionId, provider, observationEpoch?, origin: 'live'|'history', cursor, providerIdentity?, stream?, data: unknown, observedAt? }`
- `externalAgentRawHistoryPageSchema` → `{ records: ExternalAgentRawHistoryRecord[], nextCursor?, coverage: 'exact'|'settled' }`
- `externalAgentConvenienceFrameSchema` → discriminated `kind`: `ready { observationEpoch?, historyBefore? }` | `upsert { cursor, event: AgentObservationEvent }` | `remove { cursor, eventId }` | `unavailable { reason }`
- Connection snapshot: `externalAgentConnectionSnapshotSchema` → current epoch + `historyBefore` boundary + revision, for the race-free panel handshake (design lines 475, 483–484).

- [ ] Add failing schema tests: raw live frame + raw history record with `data: unknown` preserved byte-exact; raw history page with `coverage` + `nextCursor`; convenience `ready`/`upsert`/`remove`/`unavailable`; a convenience `upsert` requires non-empty `event.provenance.contractEvents` (the existing `AgentObservationEvent` provenance field — this plan does **not** migrate the provenance schema) and requires the upsert to carry the associated raw `cursor`/provider identity; connection snapshot parse.
- [ ] Run `bun scripts/bun-test.ts packages/protocol/test/unit/external-agent-observation.test.ts --only-failures`; confirm failure (schemas absent).
- [ ] Define the four schemas + snapshot schema and exact `z.infer` types. Split the adapter contract: acquisition returns raw records/frames; a separate projector interface returns `AgentObservationEvent`. Update barrels; run targeted tests to green.

### Task 2: Adapter raw acquisition split + explicit projector

**Files:**
- Modify: `packages/atoms/src/agent-adapters/event-source.ts` (`createProjectedEventSource`, `createOutputHistoryEventSource:240`, `createAppServerHistoryEventSource:276`)
- Modify: `packages/atoms/src/agent-adapters/observation-projection.ts`, `neutral-observation.ts` (`toAgentObservationEvent`)
- Modify built-in adapters with history readers: `hermes/index.ts:86`; `codex/`, `openclaw/`, `claude-code/`, `qwen/`, `gemini/`
- Test: adapter history-reader suites under `packages/atoms/test/`

- [ ] Add failing tests proving each history reader returns exact provider records (raw, pre-projection), preserving provider cursors/identities and `coverage`.
- [ ] Replace the fused `readPage`→`projectLive` path: acquisition returns `ExternalAgentRawHistoryPage`; the projector (`observation-projection.ts`) is the single pure raw→`AgentObservationEvent` function, attaching provenance. Adapters never emit convenience events from acquisition.
- [ ] Add exact `toEqual` tests proving one real provider fixture per adapter projects to the expected convenience page with complete provenance (no bare snapshot-exists assertions).

### Task 3: Host raw/convenience resolvers, hub, and epoch lifecycle

**Files:**
- Modify: `apps/monad/src/services/external-agent/host/index.ts`, `observation-resolve.ts`, `observation-hub.ts`, `output-pipeline.ts`, `history-backfill.ts`, `history-cursor.ts`
- Modify: `apps/monad/src/services/external-agent/live-raw-store.ts`
- Test: host, resolver, pipeline, live-raw-store suites (both transports)

- [ ] Add failing tests: raw-record publication before projection; projector failure isolation (a projection throw omits/diagnoses only the convenience event, raw delivery intact — design line 491); exact epoch-cache paging; provider-history paging after disconnect via the raw reader; history/live seam identity (no dup/gap, dedupe by provider identity/provenance).
- [ ] Implement one committed raw frame in the hub feeding both a raw pass-through subscription and a convenience projection subscription. Emit the `ready` frame with epoch + `historyBefore` boundary.
- [ ] Confirm terminal connection close deletes the epoch live-raw store, closes streams, and later reads call the provider (`coverage`), never a stale cache. A live-store write failure fails closed (stop/disconnect the runtime — design line 492). Remove the `output` snapshot fallback.

### Task 4: HTTP routes, JSON-RPC parity, and client APIs

**Files:**
- Modify: `apps/monad/src/handlers/external-agent/index.ts` (shared subscribe/history handlers)
- Modify: `apps/monad/src/transports/http/external-agent.ts` (routes 170/180/190/210)
- Modify: `apps/monad/src/transports/http/sessions/controller.ts` (session-member twins 476/492)
- Modify: `packages/protocol/src/rpc/method-table.ts` and `apps/monad/src/transports/jsonrpc/methods.ts` for the Unix control-transport equivalents
- Modify: `packages/client/src/index.ts`
- Replace RTK endpoints under `packages/client-rtk/src/endpoints/external-agent/` (+ `index.ts`, `api.ts`)
- Test: daemon transport suites + `packages/client/test/unit/client.test.ts`

**Target routes (design §Plane 2B — no `/observation/` segment, no aliases):**
```
GET /v1/external-agent-sessions/:id/stream/raw
GET /v1/external-agent-sessions/:id/stream/convenience
GET /v1/external-agent-sessions/:id/history/raw
GET /v1/external-agent-sessions/:id/history/convenience
GET /v1/external-agent-sessions/:id/connection            # snapshot handshake
```
Delivery (`native-agent-deliveries/:id`) and session-member (`sessions/:id/members/:memberId`) consumers **resolve to the canonical external-agent session id and reuse the one API set** — do not copy four routes onto three resource surfaces. If a distinct surface is unavoidable, record why in this plan.

- [ ] Add failing tests for `/stream/raw`, `/stream/convenience`, `/history/raw`, `/history/convenience`, `/connection`: snapshot handshake, subscribe-first→refetch race closure, missed-frame resume by cursor/`Last-Event-ID`, ordered frames, terminal completion (`isTerminal` on non-`live`), heartbeat (`startSseHeartbeat`, `idle ≥ 2×heartbeat`), resource-scoped auth, provider-cursor paging, coverage semantics.
- [ ] Add JSON-RPC method-table tests proving the Unix control transport exposes equivalent raw/convenience subscribe + history methods with the same schemas; test the shared domain handler once and the HTTP SSE framing separately (do not claim an HTTP route covers Unix).
- [ ] Implement daemon handlers, routes, JSON-RPC methods, four client methods (`streamRawObservation`, `streamConvenienceObservation`, `readRawObservationHistory`, `readConvenienceObservationHistory`) + connection snapshot method, and RTK endpoints; validate every frame with Task 1 schemas.
- [ ] Remove `/ui-observation[-stream]`, the mixed `/observation` shape, the session-member twins, `streamExternalAgentUiObservation`, and old schemas after `rg` proves no consumers remain.

### Task 5: Connection lifecycle and Observation panel state machine

**Files:**
- Modify: `apps/monad/src/services/external-agent/host/session-launcher.ts`, `app-server-connection.ts`, `process-lifecycle.ts` — emit `connection.opened`/`.closed` (schemas owned by the Message Event Plane plan) keyed by observation epoch; expose the connection snapshot.
- Modify: `packages/atoms/src/workspace-experiences/chat-room/components/agent-tasks-rail.tsx`
- Modify: `packages/atoms/src/workspace-experiences/chat-room/components/observation/panel.tsx`, `timeline.tsx`, `adapters.ts`, `provenance.ts`, `types.ts`
- Modify: `packages/atoms/src/workspace-experiences/chat-room/utils/agent-rail-model.ts`
- Test: atoms unit + Workspace Experience E2E

- [ ] Add failing tests (design §Observation panel + §Verification): panel reads the connection snapshot, subscribes-first then refetches (race-free), raw⇆convenience mode switch, stream-first-then-history join deduped at the provider boundary, connection-close terminal → dispose live subs → history reads provider-native, panel close disposes SSE without touching the runtime.
- [ ] Implement the panel connection-lifecycle state machine keyed by `observationEpoch`, reconciling by epoch + snapshot revision (not by component/session selection).
- [ ] Implement raw/convenience selection and duplicate-free history/live joining via `ready.historyBefore`.
- [ ] Run targeted atoms tests + package typechecks.

### Task 6: Observation-plane verification

- [ ] Run `bun run lint`, `bun run typecheck`, `bun run test` once each; collect the full failure surface.
- [ ] Fix only failures caused by this plan as one batch; record unrelated baseline failures separately. Rerun each scope once.
- [ ] Targeted `rg`: no durable observation payload writes, no `EXTERNAL_AGENT_OUTPUT_SNAPSHOT_MAX`, no legacy names (`ui-observation`, `observeUi`, `streamExternalAgentUiObservation`); raw payloads never logged wholesale; bounded SSE queues disconnect slow consumers.
