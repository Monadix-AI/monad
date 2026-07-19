# Message Event Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace origin-based chat events and distributed message writes with the `session.message.*` namespace, one Message Ingress, a client-lifetime lifecycle stream, and per-message generation streams.

**Architecture:** [`2026-07-18-chat-experience-realtime-planes-design.md`](./2026-07-18-chat-experience-realtime-planes-design.md) is the source design. `@monad/protocol` owns message commands, event schemas, and delivery metadata. Message Ingress is the only runtime message writer. It commits durable message state before publishing lifecycle events. The client-lifetime control stream carries low-frequency lifecycle facts. A message-scoped generation stream carries only one active message's snapshot, deltas, and terminal fact.

**Tech Stack:** Bun, TypeScript, Zod, Elysia, `bun:sqlite`, RTK Query, and React.

## Global Constraints

- Work directly on `main` as requested.
- Use Bun-only commands and `scripts/bun-test.ts ... --only-failures` for targeted tests.
- Write each regression test first and observe the expected failure before implementation.
- Keep `@monad/protocol` as the only wire-contract source.
- Parse external input at the boundary. Do not replace validation with casts.
- Preserve behavior across TCP loopback and Unix transports. WebSocket and Server-Sent Events (SSE) are web transport choices, not domain contracts.
- Keep every intermediate task typecheckable. Add target event names before migrating consumers, then remove legacy names in one final cutover. Do not ship compatibility aliases.
- Treat both `ses_` and `prj_` message owners as transcript targets. Remove the current `SessionId` casts instead of copying them into Message Ingress.
- Keep the control stream low-volume. Token, reasoning, tool-progress, and provider-raw payloads never enter it.

---

### Task 1: Define transcript-target and event-registry contracts

**Files:**

- Modify: `packages/protocol/src/ids.ts`
- Create: `packages/protocol/src/message-ingress.ts`
- Modify: `packages/protocol/src/domain.ts`
- Modify: `packages/protocol/src/event-table.ts`
- Modify: `packages/protocol/src/rpc/method-table.ts`
- Modify relevant protocol barrels
- Modify: `apps/monad/src/services/event-bus.ts`
- Modify: `apps/monad/src/services/external-agent/host/event-log.ts`
- Modify: `apps/monad/src/store/db/row-mappers.ts`
- Modify: `apps/monad/src/handlers/transcript/projector.ts`
- Test: `packages/protocol/test/unit/event-table.test.ts`
- Test: `packages/protocol/test/unit/rpc-method-table.test.ts`

**Interfaces:**

- Produces: `TranscriptTargetId`, `transcriptTargetIdSchema`, `MessageProducer`, schema-parsed Message Ingress commands, `EventDefinition`, `eventDefinition(type)`, and schemas for `session.message.*`, `session.run.*`, and `external_agent.session.*`
- Consumes: existing message, identifier, producer, provider, and observation-epoch schemas

- [ ] Add failing tests proving `transcriptTargetIdSchema` accepts `SessionId` and `ProjectId` and rejects unrelated IDs.
- [ ] Widen the message/event transcript-target contract deliberately. Keep existing JSON field names only where changing them would be a separate wire break, but type and parse their values as `TranscriptTargetId`.
- [ ] Propagate the widened type through `EventBus`, `ExternalAgentEventLog`, row mappers, and transcript projectors. Remove the current `SessionId` casts, then run the protocol and daemon typechecks.
- [ ] Define exact `deliver`, `begin`, `append`, `update`, `settle`, `fail`, and `remove` command schemas. Each durable command carries a stable idempotency key, explicit producer metadata, and message-type data; append carries a monotonic delta index and channel.
- [ ] Replace the origin/channel-oriented `streamRefSchema` contract with a message-scoped reference. Active messages identify their transcript target and message ID; settled messages expose no live subscription source.
- [ ] Add registry definitions for the target namespaces without deleting legacy definitions yet. Define delivery as `control | generation | both` and persistence as `durable | transient`; the registry schema type must remain Zod-based and must not import daemon or transport types.
- [ ] Add exact payload tests for `session.message.created`, `session.message.updated`, `session.message.deleted`, `session.message.delta.appended`, `session.message.completed`, `session.message.failed`, `session.run.*`, and `external_agent.session.connection.opened|closed`. Confirm `updated` carries the complete message and revision; confirm `deleted` carries transcript target, message ID, and revision.
- [ ] Keep the cross-plan connection payload exact: `opened` carries `externalAgentSessionId`, `provider`, and `observationEpoch`; `closed` carries the same identity plus `reason: 'exited' | 'failed' | 'stopped' | 'disconnected'`. The Observation Dual Stream plan consumes these schemas without redefining them.
- [ ] Add exhaustiveness tests proving every `EventType` has one registry definition and every RPC `emits` entry names a registered event.
- [ ] Run the two targeted protocol suites and confirm they pass while legacy consumers still typecheck.

### Task 2: Add durable message revisions and idempotent store operations

**Files:**

- Modify: `apps/monad/src/store/db/schema.ts`
- Modify: `apps/monad/src/store/db/messages.ts`
- Modify: `apps/monad/src/store/db/index.ts`
- Modify: `packages/protocol/src/rpc/control.ts`
- Add: generated Drizzle migration under `apps/monad/drizzle/`
- Test: `apps/monad/test/unit/store/messages.test.ts`

**Interfaces:**

- Produces: `Store.createMessage`, `Store.updateMessage`, `Store.settleMessage`, `Store.failMessage`, `Store.removeMessage`, `Store.getMessageRevision`, and list responses containing `messageRevision`
- Consumes: `ChatMessage`, `MessageId`, `TranscriptTargetId`, `IdempotencyKey`, and message stream schemas

- [ ] Add failing store tests for a complete delivery, update, streaming creation and settlement, failure, removal, and duplicate idempotency keys. Assert the exact message, revision, and `changed` result for every operation.
- [ ] Store revisions in a transcript-target revision table keyed by `transcript_target_id`; do not put the counter only on `sessions`, because project transcripts also own messages.
- [ ] Add `idempotency_key` to `messages` and a unique `(transcript_target_id, idempotency_key)` constraint. Preserve globally unique message IDs as a separate invariant.
- [ ] Implement each state change as one SQLite transaction returning `{ message, messageRevision, changed }`. A complete delivery advances once. A streaming creation advances once, and its terminal settlement advances once more. Deltas do not write message state or advance the revision.
- [ ] Make duplicate keys return the original result without changing the revision. Reject reuse of one key with a different command fingerprint.
- [ ] Include `messageRevision` in canonical history/list responses so reconnect repair does not depend on replaying control events.
- [ ] Generate and inspect the migration, then run the targeted store suite to green.

### Task 3: Introduce canonical Message Ingress without changing consumers

**Files:**

- Create: `apps/monad/src/services/messages/ingress.ts`
- Create: `apps/monad/src/services/messages/types.ts`
- Modify: `apps/monad/src/handlers/daemon-handlers/index.ts`
- Test: `apps/monad/test/unit/message-ingress.test.ts`

**Interfaces:**

- Produces: `MessageIngress.deliver`, `begin`, `append`, `update`, `settle`, `fail`, and `remove`
- Consumes: protocol command schemas, transactional store operations, EventBus, and existing downstream project/channel fanout

- [ ] Add failing tests for complete delivery, update, streaming begin/delta/settlement, failure, removal, duplicate idempotency, mismatched duplicate commands, and project transcript targets.
- [ ] Parse every command with protocol schemas. Validate authorization scope, producer metadata, message-type data, state transitions, and transcript-target existence before writing.
- [ ] Commit durable message state first. Publish exactly one canonical lifecycle event only when `changed` is true. Publish ordered `session.message.delta.appended` frames without persistence or revision advancement.
- [ ] Let Message Ingress allocate each canonical event ID once. Pass the same published `Event` instance to registry routing so control and generation subscribers receive the same `event.id`; transports must never mint replacement IDs.
- [ ] Keep downstream inbox/channel fanout after the canonical commit. A fanout failure must not create another message or roll back the canonical log.
- [ ] Define publication failure behavior explicitly in tests: the committed snapshot and revision remain authoritative, and reconnect reconciliation repairs the missed live notification.
- [ ] Run the targeted ingress suite to green. Do not migrate production call sites in this task.

### Task 4: Migrate every runtime message producer

**Files:**

- Modify direct message writers under `apps/monad/src/agent/`, `apps/monad/src/handlers/`, and `apps/monad/src/services/`
- Modify project, channel, Agent Client Protocol (ACP), external-agent, command, and generative-message producers
- Test affected producer suites
- Add: `apps/monad/test/unit/message-ingress-architecture.test.ts`

**Interfaces:**

- Consumes: Message Ingress from Task 3
- Produces: no direct runtime message writes outside Message Ingress and store-only migration, clone, restore, and repair adapters

- [ ] Add a static architecture test that rejects direct `insertMessage`, `setGenStatus`, or message-row mutations outside Message Ingress and an explicit allowlist of store maintenance adapters. Print every violating path.
- [ ] Run the test once and record the complete producer inventory before editing.
- [ ] Migrate each producer with a stable, source-derived idempotency key and an explicit producer contract. Provider-history reads and observation refreshes must remain side-effect free.
- [ ] Preserve existing event consumers temporarily while migrating writes. Do not dual-write message rows.
- [ ] Verify project fanout creates delivery/inbox work from the committed canonical message instead of creating transport-specific message copies.
- [ ] Run the architecture test and all affected producer suites once, fix the collected failures as one batch, and rerun the same scopes once.

### Task 5: Cut over canonical lifecycle events atomically

**Files:**

- Modify: `apps/monad/src/services/event-bus.ts`
- Modify: `apps/monad/src/handlers/session/context.ts`
- Modify: `apps/monad/src/handlers/session/ui-projection-message-events.ts`
- Modify event consumers under channels, ACP, Responses API, OpenAI compatibility, delegation, and inline-turn handling
- Modify: `packages/protocol/src/domain.ts`
- Modify: `packages/protocol/src/event-table.ts`
- Modify: `packages/protocol/src/rpc/method-table.ts`
- Test: `apps/monad/test/unit/event-bus.test.ts`
- Test all affected transport and projection suites

**Interfaces:**

- Produces: registry-driven control/generation routing and only canonical message/run event names
- Consumes: canonical Message Ingress events

- [ ] Add failing EventBus tests proving `control` and `both` events reach control subscribers, while `generation` events do not. Session/project topic subscribers and the internal `all` topic retain their documented behavior.
- [ ] Replace `CONTROL_EVENT_TYPES` with `eventDefinition(event.type).delivery`. Use the same registry metadata anywhere persistence policy is selected; do not create a second event-name set.
- [ ] Migrate producers and consumers together from `session.stream_*`, `user.message`, `agent.message`, `agent.token`, `agent.reasoning`, `message.delta`, and `message.complete` to their canonical lifecycle equivalents.
- [ ] Keep tool-progress and provider-raw output off the control plane. Move `external_agent.output` observation consumers to the observation APIs before removing that event.
- [ ] Gate `external_agent.output` removal on Observation Dual Stream Tasks 3 and 4. The event cutover may proceed first, but raw output removal must not strand Observation consumers.
- [ ] Remove legacy event schemas, enum members, RPC `emits` entries, reducers, and comments only after `rg` finds no runtime consumers. Add a schema test proving the removed names are rejected.
- [ ] Run protocol, EventBus, projection, channel, ACP, Responses API, OpenAI compatibility, and external-agent targeted suites to green, then run affected package typechecks.

### Task 6: Add message-scoped generation streams and client APIs

**Files:**

- Modify: `apps/monad/src/handlers/session/handlers/messaging-subscribe.ts`
- Modify: `packages/protocol/src/rpc/control.ts`
- Modify: `packages/protocol/src/rpc/method-table.ts`
- Modify: `apps/monad/src/transports/jsonrpc/methods.ts`
- Modify: `apps/monad/src/transports/http/sessions/stream.ts`
- Modify: `apps/monad/src/transports/http/sessions/controller.ts`
- Modify: `packages/client/src/index.ts`
- Create: `packages/client-rtk/src/endpoints/sessions/stream-message-generation.ts`
- Modify endpoint barrels under `packages/client-rtk/src/endpoints/sessions/`
- Test: `apps/monad/test/unit/session-message-stream.test.ts`
- Test: `packages/client/test/unit/client.test.ts`

**Interfaces:**

- Produces: `GET /v1/sessions/:sessionId/messages/:messageId/stream`, JSON-RPC `session.messageGeneration.subscribe|unsubscribe`, a transport-agnostic generation subscription handler, `MonadClient.streamMessageGeneration`, and the RTK endpoint
- Consumes: canonical generation events, message snapshots, revisions, and bounded live delta state

- [ ] Add failing handler and HTTP tests for scoped authorization, message ownership, initial snapshot, subscribe-before-snapshot race closure, missed-delta recovery, ordered deltas, terminal completion/failure, unknown message, slow-consumer disposal, and listener disposal.
- [ ] Add failing JSON-RPC tests proving the Unix transport exposes the same snapshot, delta, terminal, resume, authorization, and disposal semantics through `session.messageGeneration.subscribe|unsubscribe`.
- [ ] Implement a bounded per-message live delta buffer. Subscribe before reading the snapshot, then reconcile buffered frames so no delta can fall between snapshot and live tail.
- [ ] Use SSE `id` values and `Last-Event-ID` for resume. If the cursor is unavailable, send a replacement authoritative snapshot instead of silently skipping data.
- [ ] Keep the terminal event identical across the control and generation planes, including its event ID and message revision, so clients can deduplicate either arrival order.
- [ ] Add failing client tests for frame validation, resume cursor handling, terminal stop, abort disposal, and malformed-frame rejection.
- [ ] Implement the client and RTK endpoint with `clientOf(api)`. Test the shared handler over TCP loopback and Unix JSON-RPC subscriptions; test the HTTP SSE framing separately.
- [ ] Run targeted handler, transport, client, and RTK suites to green.

### Task 7: Migrate Chat state and remove whole-session generation streaming

**Files:**

- Modify: `packages/client-rtk/src/endpoints/sessions/stream-control.ts`
- Replace or remove: `packages/client-rtk/src/endpoints/sessions/stream-session.ts`
- Modify: `packages/client/src/index.ts`
- Modify: `apps/web/src/features/workplace/use-project.ts`
- Modify Chat Experience state and projection files under `packages/atoms/src/workspace-experiences/chat-room/`
- Modify: `docs/internals/realtime-channels.md`
- Remove obsolete session UI/event reducers and routes only after all consumers migrate
- Test existing web, RTK, and Workspace Experience end-to-end suites

**Interfaces:**

- Consumes: client-lifetime control events, HTTP message history with revision, and visible-message generation streams
- Produces: chat state derived only from canonical messages, durable revisions, and active generation drafts

- [ ] Add failing reducer tests for complete-message append, streaming-message subscription, WS/SSE terminal deduplication in either order, revision-gap reconciliation, off-screen unread updates, concurrent generated messages, and session-switch disposal.
- [ ] Hold one control subscription for the client lifetime. Load canonical history when a transcript opens and reconcile by message ID plus revision without assuming fetch/event order.
- [ ] Open generation subscriptions only for visible `pending` or `streaming` messages. Dispose settled and off-screen subscriptions without changing the server-side run.
- [ ] Remove `watchSession` and the whole-session SSE state path after all callers use control lifecycle plus message-scoped generation streams. Preserve Unix control notifications through the existing JSON-RPC transport.
- [ ] Update `docs/internals/realtime-channels.md` in the same task: replace `watchSession` as the passive-watcher authority with client-lifetime control lifecycle plus visible-message generation subscriptions.
- [ ] Remove legacy reducers, UI projection fallbacks, and routes after targeted `rg` checks show no consumers.
- [ ] Run focused web, RTK, and atoms tests, then affected package typechecks.

### Task 8: Verify the message plane

- [ ] Run targeted `rg` checks for direct message writers, legacy event names, duplicate delivery sets, and whole-session generation consumers.
- [ ] Run `bun run lint` once and collect all failures.
- [ ] Run `bun run typecheck` once and collect all failures.
- [ ] Run `bun run test` once and collect all failures.
- [ ] Fix failures caused by this plan as one batch. Record unrelated baseline failures separately with exact command output.
- [ ] Rerun the same complete scopes once and record final evidence.
- [ ] Verify bounded state, slow-consumer disposal, resource-scoped authorization, TCP/Unix domain parity, and no raw provider payloads in control events or logs.
