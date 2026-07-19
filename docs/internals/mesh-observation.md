# MeshAgent observation

Status: **accepted**

MeshAgent observation has two views over provider activity. The raw view preserves
accepted provider frames or native records. The convenience view projects the same
source into provider-neutral `AgentObservationEvent` operations.

## Resource scope

Every MeshSession is scoped to one Monad `SessionId`. All session-specific routes
require the same `transcriptTargetId=ses_...` query used when the runtime was created.
Supplying a different ID returns not found instead of revealing the resource.

```text
POST /v1/mesh/sessions
GET  /v1/mesh/sessions?transcriptTargetId=:sessionId
GET  /v1/mesh/sessions/:id?transcriptTargetId=:sessionId
```

Lifecycle controls live under `/v1/mesh/sessions/:id`:

```text
POST /input
POST /steer
POST /interrupt
POST /approval
POST /resize
POST /stop
```

The active adapter and launch mode determine which controls are supported.

## Connection and streams

```text
GET /v1/mesh/sessions/:id/connection
GET /v1/mesh/sessions/:id/stream/raw
GET /v1/mesh/sessions/:id/stream/convenience
```

The connection snapshot is either connected, with an observation epoch and optional
`eventsBefore` join boundary, or disconnected. Its monotonic `revision` lets clients
subscribe first and then refetch without assuming fetch/event arrival order.

Raw SSE frames contain exact accepted live data plus Monad routing metadata:

```ts
type MeshRawEvent = {
  meshSessionId: MeshSessionId;
  provider: MeshAgentProvider;
  observationEpoch?: string;
  origin: 'live' | 'events';
  cursor: ObservationCursor;
  providerIdentity?: string;
  stream?: 'stdout' | 'stderr' | 'pty' | 'app-server';
  data: unknown;
  observedAt?: string;
};
```

Convenience SSE starts with `ready`, then sends atomic patches, and may terminate with
`unavailable`:

```ts
type MeshConvenienceFrame =
  | {
      kind: 'ready';
      observationEpoch?: string;
      cursor?: ObservationCursor;
      eventsBefore?: ObservationCursor;
    }
  | {
      kind: 'patch';
      cursor: ObservationCursor;
      operations: Array<
        | { op: 'upsert'; event: AgentObservationEvent }
        | { op: 'remove'; eventId: string }
      >;
    }
  | { kind: 'unavailable'; reason: string };
```

One raw position may project to several operations. The whole patch is therefore the
resume unit; clients apply its operations in order and merge upserts by `event.id`.

`Last-Event-ID` takes precedence over `?after=` during SSE reconnect because the query
belongs to the original subscription URL while the header contains the most recently
received position.

## Event pages

The route path selects the view. `view` is not a query parameter and is not returned in
the response:

```text
GET /v1/mesh/sessions/:id/events/raw
GET /v1/mesh/sessions/:id/events/convenience
```

Both routes accept `transcriptTargetId`, an optional `before`, and `limit` from 1 to
100. Raw pages return `{ records, coverage, nextCursor? }`; convenience pages return
`{ frames, nextCursor? }`.

`coverage` describes the provider-native raw page:

- `exact`: the event source is authoritative for the requested records.
- `settled`: the source exposes settled session history but not every transient live
  transport delta.

Monad does not synthesize missing transient frames after the live epoch ends.

## Cursor contract

The wire grammar has two position forms:

```text
live:<percent-encoded-observation-epoch>:<sequence>
provider:<percent-encoded-provider-token>
```

`provider:` with an empty token is valid and means the provider's latest page. Every
opaque component is percent-encoded by the protocol formatter. Business clients never
parse either form; they return cursors unchanged to the route that supplied them.

The `before` parameter accepts both forms:

- A current `live:` cursor pages backward through the current epoch's committed raw
  store.
- A `provider:` cursor pages through the adapter-owned event source.
- A stale `live:` cursor cannot address the current store and falls back to provider
  history from its latest page.

The stream `after` position accepts only the live sequence. A provider cursor, malformed
cursor, or stale epoch is ignored rather than rejected with an HTTP error, and resumes
the current epoch from its beginning. The next `ready` frame re-anchors the client.

## Joining live and earlier activity

The current connection can expose an event before the provider makes it available in
settled history. Monad retains bounded raw frames for the current epoch so refresh and
SSE resume remain gap-free.

The convenience client joins the two sources as follows:

1. Subscribe to `/stream/convenience`.
2. Apply the `ready` anchor and subsequent patches.
3. Request `/events/convenience?before=<eventsBefore>` for earlier activity.
4. Prepend pages by stable event identity while following `nextCursor`.
5. On a new epoch, replace the old live window and re-anchor from the new `ready` frame.

Cursor position and provider event identity are separate. A cursor answers where the
consumer is; `event.id` and `providerIdentity` answer which event is being merged.

## Delivery and member observation

Managed delivery pointers resolve through:

```http
GET /v1/mesh/deliveries/:id?transcriptTargetId=:sessionId
```

The response points to a MeshSession; it does not define a delivery-scoped observation
contract. Session members without their own MeshSession, including the built-in Monad
agent, use the separate member projection routes:

```text
GET /v1/sessions/:id/members/:memberId/ui-observation
GET /v1/sessions/:id/members/:memberId/ui-observation-stream
```

## Security and reliability

- Parse every HTTP and SSE payload with its protocol schema.
- Treat provider frames, prompts, tool arguments, and metadata as hostile.
- Never log raw event payloads wholesale.
- Authorize the transcript target and MeshSession before returning raw data.
- Commit live raw data before publishing either observation view.
- Bound raw retention, projection state, page size, and subscriber queues.
- Disconnect slow consumers instead of retaining session-length state.
- Keep raw delivery available when projection fails.
- Create durable chat messages only through Message Ingress.

The schemas live in `@monad/protocol`, HTTP handling in the daemon, client parsing in
`@monad/client`, and provider acquisition in `@monad/sdk-atom` adapters.
