# Chat Experience Realtime Planes and Message Ingress

## Status

Proposed on 2026-07-18. Pending written-spec review.

## Goal

Give the Chat Experience three explicit, non-overlapping planes:

1. a client-lifetime server-event subscription for unsolicited domain facts;
2. resource-scoped SSE subscriptions only for continuous generation;
3. one canonical message ingress for every producer of chat messages.

Observation remains provider-sourced. Monad's live raw store is an ephemeral visibility cache for the connected
native-runtime epoch, not an independent observation source. When that epoch ends, Monad deletes the cache and reads
observation from provider-native history.

## Baseline on `main`

The following work is treated as the starting point, not part of this proposal:

- observation contract and neutral events carry provider raw provenance;
- each connected external-agent runtime owns an ephemeral `LiveRawStore` containing exact accepted transport frames;
- the live store supports refresh and pagination while provider history cannot yet expose current frames;
- the live store is removed on disconnect and stale stores are removed after daemon restart;
- durable observation journals and durable output snapshots are being removed as observation fallbacks;
- stopped-session observation reads the provider-native session through the adapter.

The remaining current-state mismatches are:

- the client-facing observation API still exposes the legacy UI observation stream instead of separate raw and
  convenience streams;
- observation history returns normalized events rather than offering both raw and convenience views from one raw read;
- the observation panel subscribes primarily from component/session selection, not from an explicit provider-connection
  state machine;
- message producers write storage rows and emit runtime events through several separate paths;
- the control stream has runtime/session lifecycle events but no canonical notification that a session's durable message
  state changed.

## Architecture

```text
                                  client-lifetime
                                      |
                                      v
                         server-event subscription (WS)
                       unsolicited, low-frequency facts
                         /             |              \
             message created   provider connected   provider disconnected

        streaming message created                       explicit Observation panel subscription
                    |                                                   |
                    v                                                   v
        explicit message-generation SSE                   raw SSE or convenience SSE
        scoped to one streaming message                   scoped to one native runtime

External client writes and commands use HTTP/RPC; internal producers call daemon services directly. Neither WS nor SSE is
a command transport.
```

The distinction is semantic and lifecycle-based:

- WS answers: "A durable or lifecycle fact occurred on the server."
- SSE answers: "The client explicitly selected this generating resource; continuously deliver its ordered data."
- HTTP/RPC answers: "The client or an internal producer requests a state change."

## Event Namespace

Domain event names use:

```text
<bounded-context>.<aggregate>[.<child>].<past-tense-fact>
```

Rules:

- segments are lowercase singular nouns separated by dots;
- the final segment is a fact that already happened: `created`, `updated`, `deleted`, `opened`, `closed`, `completed`,
  `failed`, `requested`, or `resolved`;
- transport names such as `ws`, `sse`, and `stream` do not appear in domain event names;
- producer identity (`user`, `agent`, `system`, `channel`) belongs in the payload, not in the event name;
- one event name has one schema on every transport; routing never changes its payload shape;
- high-frequency deltas are still domain events, but their routing policy is SSE-only;
- generic `updated` is used only when multiple fields may change together and no more precise fact exists.

The core taxonomy is:

```text
session.created
session.updated
session.archived
session.restored
session.deleted

session.run.started
session.run.completed
session.run.failed
session.run.cancelled

session.message.created
session.message.updated
session.message.deleted
session.message.delta.appended
session.message.completed
session.message.failed

external_agent.session.created
external_agent.session.started
external_agent.session.exited
external_agent.session.connection.opened
external_agent.session.connection.closed
external_agent.session.turn.started
external_agent.session.turn.completed
external_agent.session.turn.failed
external_agent.session.turn.cancelled
external_agent.session.approval.requested
external_agent.session.approval.resolved
external_agent.session.idle.suspended
external_agent.session.idle.resumed
```

`session.message.created` represents every message source. Its payload identifies the producer. `user.message` and
`agent.message` are removed because they encode origin in the event name and force consumers to reconstruct one message
lifecycle from unrelated namespaces.

`session.message.delta.appended` is the only high-frequency message event. Its payload has a `channel` such as `content` or
`reasoning`; separate `agent.token`, `agent.reasoning`, and `message.delta` event families are removed.

Transport routing is metadata on the event registry:

```ts
type EventDelivery = 'control' | 'generation' | 'both';

type EventDefinition<T> = {
  schema: Schema<T>;
  delivery: EventDelivery;
  persistence: 'durable' | 'transient';
};
```

For example:

| Event | Delivery | Persistence |
| --- | --- | --- |
| `session.message.created` | control | durable |
| `session.message.updated` | control | durable |
| `session.message.deleted` | control | durable |
| `session.message.delta.appended` | generation | transient |
| `session.message.completed` | both | durable |
| `session.message.failed` | both | durable |
| `external_agent.session.connection.opened` | control | transient |
| `external_agent.session.connection.closed` | control | transient |

This registry is the routing source of truth. `EventBus` must not maintain a second hand-written set of control event names.

Current names migrate as follows:

| Current | Target |
| --- | --- |
| `session.stream_started` | `session.run.started` |
| `session.stream_ended` | `session.run.completed`, `session.run.failed`, or `session.run.cancelled` |
| `user.message` | `session.message.created` with `producer.kind: 'user'` |
| `agent.message` | `session.message.created` or `session.message.completed` with `producer.kind: 'agent'` |
| `agent.token` | `session.message.delta.appended` with `channel: 'content'` |
| `agent.reasoning` | `session.message.delta.appended` with `channel: 'reasoning'` |
| `message.delta` | `session.message.delta.appended` |
| `message.complete` | `session.message.completed` or `session.message.failed` |
| `external_agent.started` | `external_agent.session.started`; emit `connection.opened` only when observation is ready |
| `external_agent.exited` | `external_agent.session.exited`; emit `connection.closed` when the observation source closes |
| `external_agent.output` | removed from the global event bus; raw output belongs to observation SSE |
| `external_agent.turn_settled` | a specific `external_agent.session.turn.*` terminal fact |

SSE handshake envelopes such as `snapshot` and `ready` describe transport synchronization, not domain facts, so they use
route-local `kind` values rather than entering the global event namespace.

## Plane 1: Server Events over WS

The web client holds one multiplexed WebSocket for its lifetime. It carries low-frequency domain events generated by the
server. It must not carry token deltas, provider raw frames, streamed tool output, or observation events.

### Message lifecycle

Message creation is a first-class event, not a generic "available" notification:

```ts
type SessionMessageCreated = {
  type: 'session.message.created';
  sessionId: SessionId;
  message: ChatMessage;
  messageRevision: number;
};
```

The event contains the canonical created message. A non-streaming message can be appended immediately. If
`message.stream.status` is `pending` or `streaming`, the client explicitly subscribes to that message's generation SSE.

`messageRevision` is a daemon-assigned monotonic revision of durable message state in that session. A message delivered
already complete advances the revision once. A streaming message advances it when its durable streaming row is created and
again when it completes or fails. Deltas do not advance the durable revision.

`session.message.updated` carries the complete updated `ChatMessage`; `session.message.deleted` carries its identity and
revision. Completion and failure have explicit facts because they terminate generation and are delivered both to the
message SSE and the global WS.

After WS reconnect, the client compares session message revisions and fetches messages after its known durable cursor.
Correctness never depends on receiving every WS event.

### Provider connection notification

Process lifecycle and provider connectivity are separate concepts. Observation subscription follows provider connectivity:

```ts
type ExternalAgentConnectionOpened = {
  type: 'external_agent.session.connection.opened';
  externalAgentSessionId: ExternalAgentSessionId;
  provider: ExternalAgentProvider;
  observationEpoch: string;
};

type ExternalAgentConnectionClosed = {
  type: 'external_agent.session.connection.closed';
  externalAgentSessionId: ExternalAgentSessionId;
  provider: ExternalAgentProvider;
  observationEpoch: string;
  reason: 'exited' | 'failed' | 'stopped' | 'disconnected';
};
```

`external_agent.started/exited` may remain runtime lifecycle events for other consumers, but the Observation panel must
not infer provider connectivity from them. App-server connection establishment, PTY/stdio readiness, reconnect, and
disconnect must all produce the same provider-connection contract.

For a process-backed CLI, "connected" means its raw observation source is ready to accept frames. For an app-server
adapter, it means the provider protocol connection and initialization handshake succeeded. Both definitions establish a
new observation epoch.

The Unix/JSON-RPC control transport exposes notifications with the same schemas. WebSocket is the web transport, not the
domain contract.

## Plane 2A: Message Generation SSE

The Chat view loads canonical session message history over HTTP and receives new message lifecycle facts over the global
WS. It opens SSE only for a message whose `stream.status` says generation is active. Several concurrent generated messages
may have several scoped subscriptions, but settled and off-screen messages hold none.

The target route is:

```text
GET /v1/sessions/:sessionId/messages/:messageId/stream
```

The stream begins with an authoritative snapshot of that message's current generated state and then emits its deltas and
terminal fact:

```ts
type SessionMessageGenerationFrame =
  | {
      kind: 'snapshot';
      message: ChatMessage;
      lastDeltaIndex: number;
    }
  | {
      type: 'session.message.delta.appended';
      sessionId: SessionId;
      messageId: MessageId;
      channel: 'content' | 'reasoning' | string;
      index: number;
      delta: string;
    }
  | { type: 'session.message.completed'; sessionId: SessionId; message: ChatMessage; messageRevision: number }
  | { type: 'session.message.failed'; sessionId: SessionId; message: ChatMessage; messageRevision: number };
```

Persisted `ChatMessage` remains canonical. Transient deltas only bridge active generation. The terminal frame contains the
complete persisted message and replaces any accumulated client draft. The same terminal event may arrive over both WS and
SSE; clients deduplicate by event ID and message revision.

Anything rendered in the message list must therefore have a `ChatMessage` representation. Tool calls, tool results,
system notices, and rich cards use their registered message types instead of bypassing the message log as UI-only events.

The initial snapshot closes the race between receiving `session.message.created` and opening SSE: it includes every delta
already accepted. `Last-Event-ID` resumes later reconnects. If a cursor cannot be resumed, the server sends another
authoritative message snapshot. Cross-channel ordering between WS and SSE is deliberately unspecified.

The HTTP history response includes `messageRevision`. Because the global WS is client-lifetime, the client can reconcile
history with lifecycle events received before, during, or after the fetch by message ID and revision; no fetch/subscribe
ordering assumption is required.

## Plane 2B: Observation Raw and Convenience APIs

Replace the legacy UI observation routes without compatibility aliases:

```text
GET /v1/external-agent-sessions/:id/stream/raw
GET /v1/external-agent-sessions/:id/stream/convenience

GET /v1/external-agent-sessions/:id/history/raw
GET /v1/external-agent-sessions/:id/history/convenience
```

Both live and history views begin with provider raw data. Convenience is a projection, never a separate acquisition path:

```text
provider live transport ---------> ephemeral live raw store -----> raw live stream
                                             |
                                             +-- adapter projection -> convenience live stream

provider native history reader -------------------------------> raw history
                                             |
                                             +-- adapter projection -> convenience history
```

### Raw contract

Monad may add routing and ordering metadata but must not normalize `data`:

```ts
type ExternalAgentRawFrame = {
  externalAgentSessionId: ExternalAgentSessionId;
  provider: ExternalAgentProvider;
  observationEpoch?: string;
  origin: 'live' | 'history';
  cursor: string;
  providerIdentity?: string;
  stream?: 'stdout' | 'stderr' | 'pty' | 'app-server';
  data: unknown;
  observedAt?: string;
};
```

For live text transports, `data` is the exact accepted string frame. For provider history, it is the exact provider record
returned by the adapter's raw history reader. Raw delivery occurs before `parseOutput`, `events.projectLive`, merging,
deduplication, or neutral-event conversion.

The adapter history contract therefore returns raw pages:

```ts
type ExternalAgentRawHistoryPage = {
  records: ExternalAgentRawHistoryRecord[];
  nextCursor?: string;
  coverage: 'exact' | 'settled';
};
```

An adapter must not return normalized observation events from its acquisition method. It exposes a raw reader and a
projector as separate capabilities.

### Convenience contract

Convenience frames carry Monad's neutral `AgentObservationEvent` contract. They are incremental upserts rather than a
full projected list on every tick:

```ts
type ExternalAgentConvenienceFrame =
  | { kind: 'ready'; observationEpoch?: string; historyBefore?: string }
  | { kind: 'upsert'; cursor: string; event: AgentObservationEvent }
  | { kind: 'remove'; cursor: string; eventId: string }
  | { kind: 'unavailable'; reason: string };
```

Stable event identity and provenance allow later raw deltas to update a merged thinking/tool item without replacing the
whole timeline. A convenience event may be persisted as a chat message only through Message Ingress; the observation
stream itself never mutates chat state.

### History/live seam

The client opens the live SSE before loading older history. The first `ready` frame provides the runtime epoch and the
history boundary. The client buffers subsequent live frames, loads history before that boundary, deduplicates by real
provider identity/provenance, then releases the buffered live frames.

While connected, the ephemeral live raw store covers frames not yet visible through provider history. On connection close,
the server emits a terminal frame, closes the streams, deletes the epoch cache, and future history requests read the
provider-native session.

`coverage: 'exact'` means provider history is authoritative for the requested native records. `coverage: 'settled'` means
the provider exposes settled native-session records but not every transient transport delta. After the live epoch ends,
Monad is strictly equal to what the provider-native history exposes; it does not retain or synthesize missing transient
frames.

## Plane 3: Canonical Message Ingress

Chat messages form one durable business log. Their producers include users, channels, agent-facing MCP calls, native-agent
events selected by policy, Monad system behavior, ACP/external-agent forwarding, and generative message services.

No producer may call the message store directly or independently publish message UI events. All producers use one daemon
service:

```ts
interface MessageIngress {
  deliver(command: DeliverMessageCommand): Promise<ChatMessage>;
  begin(command: BeginMessageCommand): Promise<ChatMessage>;
  append(command: AppendMessageCommand): Promise<void>;
  settle(command: SettleMessageCommand): Promise<ChatMessage>;
  fail(command: FailMessageCommand): Promise<ChatMessage>;
}
```

Commands carry explicit producer and message contracts:

```ts
type MessageProducer =
  | { kind: 'user'; userId?: string }
  | { kind: 'agent'; agentId: string; externalAgentSessionId?: ExternalAgentSessionId }
  | { kind: 'agent-facing-mcp'; serverId?: string; agentId?: string }
  | { kind: 'channel'; channel: string; senderId?: string }
  | { kind: 'system'; subsystem: string };

type DeliverMessageCommand = {
  sessionId: SessionId;
  idempotencyKey: string;
  producer: MessageProducer;
  role: ChatMessage['role'];
  type: ChatMessage['type'];
  text: string;
  data?: unknown;
  includeInContext?: boolean;
};
```

`@monad/protocol` owns the schemas. Message-type-specific data is validated through the existing message type registry;
external input is parsed, never cast.

Message Ingress owns:

1. authorization and session scope validation;
2. message-type and metadata validation;
3. idempotency within the session;
4. message ID, timestamp, and ordering assignment;
5. the message state machine (`pending -> streaming -> complete | failed`);
6. durable message persistence;
7. post-commit publication of the canonical `session.message.*` event;
8. registry-driven routing to WS and, for generation events, the scoped message SSE;
9. downstream fanout/inbox dispatch after the canonical message commits.

Message persistence and the durable message revision update occur in one database transaction. Live publication occurs only
after commit. A reconnect repairs any missed publication from the canonical snapshot and revision.

`append` publishes a transient ordered delta and does not advance the durable message revision. `settle` and `fail` receive
the complete final message value, persist it, and advance the revision; correctness never depends on replaying every delta.

The canonical message log and recipient delivery queues are distinct. Project fanout creates delivery/inbox work from a
committed message; it does not create alternative message records per transport. Existing Project Session routing semantics
remain unchanged.

### Native observation to message policy

Provider events do not automatically become chat messages:

```text
raw provider event
  -> convenience contract event
      -> message-production policy
          -> observation only
          -> MessageIngress.deliver(...)
```

The policy supplies an idempotency key derived from provider session identity and provider event identity. Re-reading
history or reconnecting observation can therefore never duplicate a chat message. Observation refresh has no side effects.

## Client State Machines

### Chat

1. Hold the global server-event WS subscription for the client lifetime.
2. Open the project/session and load canonical message history over HTTP.
3. Append `session.message.created` messages received over WS.
4. If a created message is streaming and belongs to the visible session, open its scoped generation SSE.
5. Fold `session.message.delta.appended` frames and replace the draft on `completed` or `failed`.
6. For off-screen sessions, use message lifecycle events only to update unread/session ordering.
7. On session switch, dispose message-generation SSE subscriptions that are no longer visible.

### Observation panel

1. Open the panel and read the current external-agent connection snapshot.
2. Observe control notifications for matching connection open/close events.
3. If connected, subscribe to either raw or convenience SSE for that epoch.
4. Open the stream first, then load matching history and join at the supplied boundary.
5. On connection close, consume the terminal frame, dispose live subscriptions, and switch history reads to provider-native
   history.
6. Closing the panel disposes its SSE but does not affect the provider runtime.

The initial connection snapshot plus subsequent control subscription must be race-free. The server should expose a
snapshot-and-revision handshake or the client must subscribe first and then refetch before acting.

## Failure Semantics

- A lost control notification is repaired by refetching session/runtime snapshots after WS reconnect.
- A resumable SSE reconnects from its last cursor; an unavailable cursor produces an authoritative replacement snapshot or
  an explicit observation gap.
- Raw projection failure does not suppress raw delivery. It may omit or diagnose only the corresponding convenience event.
- A live-store write failure fails closed and stops/disconnects the provider runtime rather than publishing an observation
  frame that cannot survive client refresh.
- Provider history unavailable returns `unavailable`; Monad never falls back to chat messages or a durable observation copy.
- Message Ingress publishes only after commit. Publication failure does not roll back a committed message; revision/snapshot
  reconciliation repairs clients.

## Security and Resource Bounds

- Every SSE route performs resource-scoped authorization.
- Raw frames are hostile provider data and are never logged wholesale.
- Raw endpoints are privileged diagnostic surfaces. They preserve provider values exactly, never log them wholesale, and
  require explicit authorization; convenience/UI projections continue to apply normal display containment.
- SSE consumers have bounded send queues and disconnect slow clients rather than accumulating session-length state.
- The global WS carries no high-volume payload and cannot be starved by generation traffic.
- Message producer metadata is schema-validated; arbitrary producer data cannot grant routing or authorization privileges.

## Migration Boundaries

Implementation should proceed in dependency order:

1. finish and verify the in-progress provider-sourced live-store/history migration;
2. introduce Message Ingress and migrate every direct `insertMessage` producer without changing UI behavior;
3. replace origin-based message events with the `session.message.*` namespace and registry-driven delivery metadata;
4. migrate Chat history to HTTP + WS message lifecycle events + per-message generation SSE;
5. split adapter raw history acquisition from convenience projection;
6. add raw and convenience history/live endpoints and client methods;
7. make the Observation panel connection-lifecycle driven;
8. remove legacy UI observation routes, contracts, client methods, and projection fallbacks.

Steps 2-4 and 5-7 can be planned independently after the shared protocol names are fixed. Each daemon behavior must match
over TCP loopback and Unix transport; the web-specific control subscription uses WS while Unix clients receive the same
domain notifications through their JSON-RPC control channel.

## Verification

Tests must prove:

- inactive sessions create no message-generation SSE connection but still receive WS message lifecycle events;
- switching sessions disposes off-screen message-generation SSE subscriptions without message loss;
- a streaming `session.message.created` event opens a scoped SSE whose initial snapshot includes deltas emitted before
  subscription;
- WS/SSE arrival order cannot duplicate or omit durable messages;
- every current direct message producer is migrated to Message Ingress;
- duplicate producer idempotency keys create one message and one message revision;
- streaming message creation, delta, settlement, failure, and reconnect produce the exact canonical message state;
- provider connection open/close drives Observation subscriptions by runtime epoch;
- raw live frames and raw history records arrive without Monad normalization;
- the same raw page produces the corresponding convenience page with complete provenance;
- projector rejection leaves raw delivery intact;
- history/live joining is duplicate-free at the provider boundary;
- closing the provider connection deletes the live cache and subsequent history reads the provider;
- provider-history refresh cannot create chat messages unless Message Ingress receives an explicit idempotent command;
- bounded queues prevent a slow WS/SSE consumer from growing daemon memory;
- TCP and Unix transports expose equivalent domain behavior.

## Out of Scope

- changing existing Project Session fanout or mention routing;
- making observation data a durable Monad history source;
- sending high-frequency message or observation payloads over the global WS;
- keeping SSE subscriptions for sessions or panels the user is not viewing;
- compatibility aliases for the legacy external-agent UI observation API.
