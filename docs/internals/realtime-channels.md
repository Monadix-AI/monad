# Realtime channels: control, message generation, and UI projection

Status: **accepted**

Monad splits realtime delivery by scope and payload volume. A client keeps one low-volume control connection, subscribes to generation only for messages it is actively rendering, and may use the server-projected UI stream for non-message experience state. The protocol event registry is the source of truth for delivery and persistence.

For physical TCP/Unix transport details, see [runtime.md](runtime.md). The wire contracts live in [`@monad/protocol`](../../packages/protocol), the transport client in [`@monad/client`](../../packages/client), and shared caches in [`@monad/client-rtk`](../../packages/client-rtk).

## Channel map

| Channel | Scope | Carries | Does not carry |
| --- | --- | --- | --- |
| WebSocket `/v1/stream` | client lifetime | session/run/message lifecycle, task lifecycle, connection state, interaction notifications | token, reasoning, tool progress, provider-raw output |
| SSE `/v1/sessions/:sessionId/messages/:messageId/stream` | one active message | authoritative message snapshot, ordered `session.message.delta.appended`, terminal `completed` or `failed` | other messages or unrelated session events |
| SSE `/v1/sessions/:id/ui-stream` | one visible transcript | neutral `SessionUiEvent` snapshots/upserts/removals for app presentation | provider-native raw observation |
| Inline SSE `POST /v1/sessions/:id/messages` | one caller-owned turn | events needed to render the submitted turn | passive observation of later turns |

External-agent diagnostics use their own raw and convenience observation streams. They are not chat-generation channels; see [external-agents.md](../usage/external-agents.md).

## Canonical message lifecycle

Message Ingress is the only runtime writer of chat messages. It commits durable state before publishing:

```text
session.message.created        control
session.message.updated        control
session.message.deleted        control
session.message.delta.appended generation
session.message.completed      control + generation
session.message.failed         control + generation
```

Every payload carries `transcriptTargetId` and `producer`. Durable lifecycle events carry the complete message snapshot and `messageRevision`; a delta carries `messageId`, channel, monotonic index, and text. The terminal event has the same `event.id` on both control and generation delivery. Clients therefore deduplicate by event ID and reconcile durable state by message ID plus revision.

Delta delivery is transient. Correctness never depends on replaying every delta because a reconnect can replace local draft state with an authoritative snapshot.

## Chat client state machine

1. Hold one control subscription for the client lifetime.
2. When a transcript opens, load canonical message history and its durable revision.
3. Fold control lifecycle events by message ID and revision without assuming fetch/event order.
4. When a visible message is `pending` or `streaming`, open its message-scoped generation stream.
5. Apply ordered deltas to that draft. Replace it on a terminal frame, regardless of whether the terminal arrives first on control or SSE.
6. Dispose the generation stream when the message settles or leaves the visible set. Disposing a viewer never cancels the server run.
7. For off-screen transcripts, consume lifecycle only for unread/session ordering; do not open generation streams.
8. On session switch, dispose every generation subscription owned by the previous view.

The initial message stream frame is a snapshot. The server subscribes before reading it and reconciles the buffered tail, closing the snapshot/live race. Resume uses both `Last-Event-ID` and `?after=`. If a cursor is no longer available, the server sends a replacement snapshot rather than silently skipping state.

## Control plane

`EventSocket` multiplexes the WebSocket and keeps the `control.subscribe` subscription alive across reconnects. Control events are registry entries whose delivery is `control` or `both`. The control plane stays low-volume so a token flood cannot starve task/session lifecycle or interaction delivery.

Run activity uses:

```text
session.run.started
session.run.completed
session.run.failed
session.run.cancelled
```

These events describe execution lifecycle only. They do not contain generated text and are not a signal to open a whole-session token stream.

## Message-generation transport

HTTP clients use:

```http
GET /v1/sessions/:sessionId/messages/:messageId/stream
Last-Event-ID: evt_...
```

Unix JSON-RPC clients use the equivalent `session.messageGeneration.subscribe` and `session.messageGeneration.unsubscribe` methods. Both transports share the same handler, authorization, snapshot/delta/terminal semantics, bounded live buffer, and disposal behavior.

Every subscription is resource-scoped: the session must exist and the message must belong to it. A slow or disconnected consumer is disposed without affecting the run or other consumers.

## UI projection stream

The UI stream is a presentation projection, not the canonical message log. It emits neutral `SessionUiEvent` frames for messages, tool cards, approvals, context notices, tasks, and extension items. Web and TUI surfaces may use it when they need the same server-derived ordering and presentation semantics.

Canonical message state still lives in message history and Message Ingress. Restore/reset may send a replacement UI snapshot; clients must replace their projected window instead of patching multiple caches independently.

Provider-raw output never enters this stream. External-agent raw/convenience observation has separate authorization, history, cursor, and connection-epoch semantics.

## Shared SSE engine

Standing SSE consumers use `MonadClient.stream<T>` and `readTypedSseStream`. The engine provides:

- schema validation before delivery;
- resume with `Last-Event-ID` and `?after=`;
- equal-jitter reconnect backoff;
- heartbeat-aware idle recovery;
- terminal-frame shutdown;
- abort/disposer support;
- isolation of consumer callback errors.

Every new standing SSE endpoint must send heartbeat comments. `SSE_IDLE_TIMEOUT_MS` must remain at least twice `SSE_HEARTBEAT_MS`.

The inline POST stream is request-scoped and intentionally has no reconnect semantics. It drains the response for the submitted turn and stops when that request ends.

## Ordering and recovery rules

- There is no ordering guarantee between WebSocket and SSE delivery.
- Durable history plus `messageRevision` is authoritative.
- The same terminal event ID on both planes makes either arrival order safe.
- A lost control notification is repaired by history/session refetch after reconnect.
- A lost delta is repaired by message snapshot replacement.
- Bounded caches and buffers must evict old replay keys together with their retained state.
- Generation subscriptions are view resources, not run ownership handles.

## Conformance checklist

- [ ] Is low-frequency lifecycle routed through registry delivery to control?
- [ ] Are token/reasoning deltas scoped to one message-generation subscription?
- [ ] Does the message stream authorize both session and message ownership?
- [ ] Does reconnect resume or return an authoritative replacement snapshot?
- [ ] Is the terminal `Event` identical on control and generation delivery?
- [ ] Does the client deduplicate by event ID and reconcile by message revision?
- [ ] Are settled/off-screen/session-switched subscriptions disposed?
- [ ] Are all growing replay buffers, indexes, and caches bounded?
- [ ] Are provider-raw frames confined to observation APIs?
- [ ] Does every standing SSE endpoint send heartbeats and use the shared decoder?
