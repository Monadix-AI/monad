# Realtime channels: WS control plane vs SSE generation stream

Status: **accepted** · Supersedes the ad-hoc mix where per-session generation was
streamed over WebSocket on some clients.

This records *which* realtime channel carries *which* events, and why. For the
physical transport (tcp/uds) and the REST/RPC split, see
[runtime.md](runtime.md). For the client-side code that implements this, see
[`@monad/client`](../../packages/client) (`EventSocket` for the WS, `MonadClient.stream`
for every SSE consumer) and [`@monad/client-rtk`](../../packages/client-rtk)
(`stream-control`, `stream-session`). The SSE frame decoder itself is shared once in
[`@monad/protocol`](../../packages/protocol) (`readTypedSseStream`).

## Decision

There are two realtime channels, split by **event kind**, not by who triggered the
  event:

- **WebSocket (`/v1/stream`) — control plane.** Carries low-frequency,
  cross-session **lifecycle** events that arrive unsolicited: `session.created`,
  `session.updated`, `session.deleted`, `session.restored`,
  plus the two stream markers `session.stream_started` / `session.stream_ended`
  (a turn began / settled in some session). A client holds **one** multiplexed WS
  for its whole lifetime to learn that *something happened* — e.g. another client
  (or a channel like Telegram) created a session, or a turn started/finished
  elsewhere. The same socket carries the subscribe/unsubscribe control RPCs.
  The markers are publish-only (never persisted) and carry no generation payload —
  they are the signal that tells a client *when* to open or close an SSE
  subscription, never the tokens themselves.

- **SSE (`GET /v1/sessions/:id/events`) — data plane.** Carries the high-frequency
  **generation** stream for a single session: `user.message`, `agent.token`,
  `agent.reasoning`, `agent.message`, `tool.called`, `tool.result`,
  `message.delta`, `message.complete`, `context.usage`, `context.evicted`, `clarify.*`,
  `tool.approval_*`, `agent.error`.

**A client MUST explicitly subscribe to a session's generation stream over SSE.**
Generation events are never pushed over the WS control plane. The WS may tell a
client a session is active; it is then the client's job to open an SSE subscription
if it wants the tokens.

Two SSE flavours, both data-plane, choose by use case:

- **Request-scoped** — `POST /v1/sessions/:id/messages` with
  `accept: text/event-stream` returns *this turn's* events inline
  (`MonadClient.sendStreamable`). One round-trip; ideal for "I sent it, stream me
  the reply" (the CLI's `chat`/`session send`).
- **Standing** — `GET /v1/sessions/:id/events` with `last-event-id`
  (`MonadClient.streamEvents`). Observes a session including turns started by
  *other* clients; the only option when there is no POST to ride
  (web/RTK `useStreamSessionQuery`).

## Watching a whole session: the lifecycle-driven SSE state machine

A session outlives any single turn — it is a long-lived thing that generates in
bursts. "Observe a session" therefore is not "open one SSE and hold it forever";
it is a small state machine driven by the control plane:

```
watchSession(sessionId):
  hold WS control subscription (filtered to this sessionId)   # always on
  on session.stream_started:  open SSE (if not already open)
  on session.stream_ended:    close SSE                       # idle between turns
  SSE events + control lifecycle → merged, de-duped by event id → consumer
  at start: open SSE once up front to catch a turn already in flight
```

The control plane says *when* the session is generating; SSE carries *what* is
generated, and only while a turn is in flight. Between turns no SSE connection is
held — which is the whole point for a **passive watcher** (the CLI `session watch`,
or a dashboard tailing many sessions): it must not pin one idle SSE per session.

This differs from an **active viewer** (a web transcript the user is looking at),
which simply holds one SSE open for the whole view across turns — simpler, and the
idle cost is irrelevant because there is exactly one. Pick the pattern by role:
hold-open for the focused transcript, open-on-demand (`watchSession`) for watchers.

`MonadClient.watchSession()` implements the passive-watcher machine and is the
compliant replacement for the deprecated per-session WS `subscribe`. Because the control
and SSE planes overlap on a few session-scoped lifecycle events, it de-dupes by
`event.id` (events are idempotent by id) so the consumer sees each event once.

## The SSE transport engine (`MonadClient.stream`)

Every standing SSE consumer — session events, projected UI events, developer logs,
native-CLI auth/observation snapshots — runs on one generic engine,
`MonadClient.stream<T>(path, schema, onEvent, opts)`. The named `stream*` methods are
thin presets over it that bake in each stream's URL, schema, and whether it resumes, so
a caller can't forget a correctness-critical option. The engine is business-agnostic;
the frame decode is shared once more in `@monad/protocol` (`readTypedSseStream`), used
by both the web client and the Bun-side ACP bridge.

What the engine guarantees:

- **Reconnect with equal-jitter backoff.** A dropped connection retries with
  `delay/2 + random(0, delay/2)`, base doubling 1s→30s, reset after a clean read. The
  jitter is load-bearing: several client instances (browser tabs, CLI, TUI) that drop
  together on a daemon restart must not reconnect in lockstep and stampede it.
- **Resume across reconnects (backfill).** When resumable, the last seen event id is
  threaded back as both the `last-event-id` header and an `?after=` query, so a mid-turn
  reconnect continues rather than losing events — this is how hard constraint 1 is met
  in practice.
- **Idle watchdog + heartbeat (liveness).** A silently half-open socket emits no
  `close`, so a connected stream delivering no bytes for `SSE_IDLE_TIMEOUT_MS` is
  force-reconnected. To keep a genuinely-idle-but-healthy stream (a quiet session
  between turns) from tripping it, the server writes a `:` comment every
  `SSE_HEARTBEAT_MS`; any byte, heartbeat included, re-arms the watchdog. An idle-driven
  reconnect is proactive maintenance, not a failure — it is silent, never surfaced as an
  error. See hard constraint 5 for the `idle ≥ 2×heartbeat` contract.
- **Terminal frames.** A stream may declare a frame that ends it for good (`isTerminal`);
  the engine then stops instead of reconnecting. Used by the native-CLI observation
  stream, whose non-`live` snapshot means the process exited.
- **`onOpen` recovery signal.** Fires on each successful (re)connect so a UI can clear a
  "reconnecting…" state deterministically, without waiting for the next event.
- **Version-skew and consumer-bug resilience** (in `readTypedSseStream`): an unparseable
  or schema-invalid frame is skipped — a newer daemon's unknown event type can't wedge
  the stream — and a throwing `onEvent` callback is isolated, so a consumer bug can't
  become an infinite reconnect loop re-poisoning every retry.

The one SSE consumer **not** on this engine is the request-scoped inline turn stream
(`sendStreamable` over a POST): a single turn with no resume semantics, it drains the
Eden Treaty async-iterable directly.

Server side, the same machinery is generalized by `createPushSseResponse` (in
`apps/monad`), which turns any live push source — e.g. native-CLI observation snapshots,
the coalesced replacement for what used to be a 900 ms poll — into a heartbeat-bearing,
backpressure-bounded SSE `Response`.

## Why this split

1. **SSE is the canonical LLM token transport.** Unidirectional server→client,
   text, HTTP-native, built-in `Last-Event-ID` resume, HTTP backpressure. Pushing
   tokens over WS means hand-rolling resume and framing for no benefit.
2. **Control vs data plane is the right separation.** Lifecycle is low-volume,
   unsolicited, and must be always-on — it needs a persistent push channel (WS),
   which also gives us the bidirectional subscribe RPC. Generation is high-volume,
   scoped to what the user is actually viewing, and opt-in.
3. **Explicit opt-in for generation is the highest-value rule:**
   - **Fan-out cost** — token floods go only to viewers who asked, not broadcast to
     every client watching the session list.
   - **Authorization** — each SSE subscribe is a natural per-session authz
     checkpoint, instead of one WS firehose that pushes everything everywhere.
     Matters once the daemon is reachable beyond loopback (peer federation / remote).
   - **Scope** — the WS only ever carries low-frequency metadata, so it stays
     stable and is never starved by token volume.

### Alternative considered: everything over SSE

A single global control SSE could replace the WS, unifying on one protocol. Rejected:
SSE is server→client only, so subscribe/unsubscribe would become separate POSTs.
The WS already provides bidirectional control on one connection; keeping it is worth
the second protocol. Generation, however, stays SSE-only.

## Hard constraints this decision imposes

These are requirements, not nice-to-haves. Violating them produces user-visible bugs.

1. **SSE subscription MUST resume from an event id (backfill), not only "from now".**
   A client that opens a session mid-turn (e.g. after seeing `session.updated` on the
   WS) must not lose the already-emitted tokens. The flow is: load history (REST) →
   subscribe SSE with `last-event-id` = the last history event id. `streamEvents`
   supports `afterEventId`; this is mandatory, not optional.
2. **No cross-channel ordering guarantee.** A WS lifecycle event and an SSE
   generation event for the same turn may arrive in either order. The UI must treat
   persisted history as canonical. Restore and reset rebuild the focused session's UI
   projector and emit an authoritative replacement snapshot over its SSE; clients must
   discard both the live window and any locally paged history when that marker arrives.
   Do not reconcile transcript mutations by patching multiple client caches.
3. **Serve the daemon over HTTP/2 (or keep one active SSE per client).** Under
   HTTP/1.1 a browser caps 6 connections per origin; one SSE per open session plus
   the WS can hit it. HTTP/2 multiplexes many SSE streams over one connection.
   A web app reaching the daemon through a proxy must confirm h2 end-to-end.
4. **React Native must use an SSE client, not WS, for generation.** RN's `fetch`
   has poor streaming-body support, which is why mobile historically streamed
   generation over WS — that path is now disallowed. Mobile must adopt a maintained
   RN SSE library (e.g. `react-native-sse`) and the shared RTK
   `useStreamSessionQuery`, rather than a hand-rolled WS reducer.
5. **Server heartbeat interval < client idle timeout.** Every standing SSE response
   writes a `:` keepalive every `SSE_HEARTBEAT_MS` (`startSseHeartbeat`); clients
   reconnect after `SSE_IDLE_TIMEOUT_MS` of total silence. These two constants are a
   cross-tier contract in `@monad/protocol` and MUST keep `idle ≥ 2×heartbeat`, or a
   healthy idle stream false-reconnects every cycle. Any new SSE-emitting endpoint must
   send the heartbeat — an endpoint that streams without it will be reaped by the
   client's watchdog whenever it goes quiet.

## Consequences / migration

- `EventSocket` (the WS) is now a **pure control channel**: the per-session
  `subscribe(sessionId)` path, the `sessions` map, and the per-session branch of
  `resubscribeAll`/`onMessage` are gone, along with `MonadClient.subscribe` and the
  `sessions.subscribe`/`sessions.unsubscribe` JSON-RPC methods (server handlers +
  the protocol method-table entries + the connection's `subscriptions` map). The
  server's `bus.subscribe` / `session.subscribe` handler stays — it backs the SSE
  endpoint `GET /v1/sessions/:id/events`, which is the per-session generation channel.
- **CLI `session watch`** uses `client.watchSession` (WS lifecycle + on-demand SSE)
  instead of `client.subscribe` (WS). CLI runs on Bun where SSE works natively.
- **Mobile** moved from `useWsSessionStream` (WS) to `client.watchSession` over an
  RN SSE client (`react-native-sse`), eliminating its hand-rolled stream-folding
  reducer. RN's `fetch` can't stream SSE bodies, so the SSE client is installed as a
  global `EventSource` polyfill that `streamEvents` picks up.
- Two reconnect implementations are accepted as the standing cost: WS resubscribe,
  and SSE `last-event-id` resume. Keep each minimal.

## Conformance checklist

When adding a realtime feature:

- [ ] Is the event **lifecycle/cross-session**? → WS control plane.
- [ ] Is the event part of a **session's generation**? → SSE, and the client
      subscribes explicitly.
- [ ] Does the SSE consumer pass `last-event-id` / `afterEventId` so a mid-turn
      subscriber backfills? (constraint 1)
- [ ] Does the UI treat history as canonical rather than assuming cross-channel
      order? (constraint 2)
- [ ] On RN, does generation go through an SSE client (never WS)? (constraint 4)
- [ ] Does a new SSE-emitting endpoint send the `:` heartbeat (`startSseHeartbeat`), so
      the client's idle watchdog doesn't false-reconnect it when it goes quiet?
      (constraint 5)
- [ ] Does a new client-side SSE consumer run on `MonadClient.stream` (reconnect,
      resume, idle watchdog) rather than a hand-rolled fetch loop?
