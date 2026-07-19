# Author a MeshAgent adapter

A MeshAgent provider adapter translates one provider's launch, control, authentication,
and event semantics into Monad's shared contracts. The daemon owns authorization,
process and socket supervision, observation epochs, bounded queues, and HTTP/SSE
validation.

The authoring contract is `MeshAgentProviderAdapter` in `@monad/sdk-atom`. Register it
through `AtomPackContext.registerAgentAdapter`.

## Event-source contract

`events.projectLive` is the only required event-source member. Incremental projection
and provider history are optional:

```ts
interface MeshAgentEventSource {
  projectLive(args: {
    id: string;
    output: string;
    mode?: 'live' | 'events';
  }): MeshAgentProjectionPage;

  createLiveProjector?(args: { id: string }): {
    advance(delta: string): MeshAgentProjectionPage;
  };

  readPage?(
    context: MeshAgentProviderEventContext,
    request: MeshAgentEventPageRequest
  ): Promise<MeshAgentEventPageResult>;
}
```

The projection result is an adapter capability shape, not an HTTP convenience page:

```ts
interface MeshAgentProjectionPage {
  events: MeshAgentObservationEvent[];
  nextCursor?: string;
}
```

The daemon converts projected `events` into wire-level convenience `frames`.

## Provider history

The daemon supplies this context when the provider has an established session identity:

```ts
interface MeshAgentProviderEventContext {
  providerSessionRef: string;
  workingPath: string;
}
```

Adapters read provider-owned history from `workingPath` and `providerSessionRef`.
Provider-specific APIs, files, commands, cursors, and protocol vocabulary remain inside
the adapter; the daemon never lends its live session handle to history readers.
`MeshAgentEventPageRequest.limit` is the page capacity in complete provider records, not
a byte budget. File-backed adapters must not cut a JSONL record at a byte boundary, and
their `before` cursor must remain stable if the provider appends new records.

```ts
type MeshAgentEventPageResult =
  | ({ state: 'available'; view: 'convenience' } & MeshAgentProjectionPage)
  | ({ state: 'available'; view: 'raw' } & MeshRawEventPage)
  | {
      state: 'unavailable';
      reason: 'unsupported' | 'not-found' | 'temporary';
    };
```

Return `unavailable` when the capability exists but cannot provide the requested page.
Do not manufacture an empty authoritative page for a temporary provider failure.

Raw provider pages use adapter-native records and cursors. `coverage: 'exact'` means the
source is authoritative for those records; `settled` means it omits transient live
deltas. The daemon wraps adapter cursors in the wire-level `provider:` namespace, so the
adapter receives and returns only its own opaque token.

## Projection rules

- Capture accepted live data before parsing, projection, merging, or deduplication.
- Preserve raw provider records byte-for-byte or value-for-value.
- Project deterministic `MeshAgentObservationEvent` values with non-empty raw
  provenance.
- Give stable provider entities stable event identities across live and historical
  reads.
- Preserve meaningful unknown records as shared diagnostic envelopes.
- Keep raw acquisition available if convenience projection fails.
- Never emit UI components, labels, cards, or view state from an adapter.

`createLiveProjector` is useful when reparsing the full prefix on every delta would be
expensive. Its incremental output must be equivalent to `projectLive` over the same
complete input.

## Session runtime and controls

Mesh session execution has one entry point: `createSessionRuntime`. It returns a
session-scoped driver and either a resident or per-turn plan. Both produce the same
normalized session-event stream; process lifetime, framing, and provider protocol names
remain internal implementation details.

Resident drivers implement `attachChannel` and `sendTurn`. Per-turn drivers implement
`attachTurnChannel` and `completeTurn`, and must resume through a stable
`providerSessionRef`. Controls are declared as effective driver capabilities:
`approvalResolution`, `steer`, and `interrupt`. Unsupported controls are `false`, not
optional methods that the daemon guesses from a provider or launch mode.

PTY is not a Mesh session runtime. Use it only for provider-owned authentication, setup,
or explicit diagnostics. A one-shot CLI qualifies only when it streams structured events
during the invocation and can resume the same provider session on the next turn.

The daemon resolves the executable, validates cwd and environment additions, owns the
channel resource, captures raw packets before decoding, bounds event ingestion, and
performs teardown. The daemon owns the `allowAutopilot` decision; the adapter owns
provider-specific unsafe arguments and must report capabilities truthfully.

When the provider protocol has request IDs, record the request kind when sending and
dispatch responses through that ledger. Do not infer response types from payload shape.

## Authentication and usage

Provider authentication remains provider-owned. Implement the applicable adapter
surfaces:

- an interactive auth launch;
- an auth-status probe and parser;
- an optional usage probe and parser.

Probe launch specifications are argv arrays, never shell strings. Bound output, parse
untrusted results, avoid logging credentials, and return `unknown` rather than guessing
an authenticated state.

## Authoring sequence

1. Declare the provider ID, label, product icon, discovery probe, settings, and models.
2. Implement a session-scoped structured event driver.
3. Return a resident or resumable per-turn runtime from `createSessionRuntime`.
4. Implement `events.projectLive`.
5. Add `createLiveProjector` only when incremental state is useful.
6. Add `events.readPage` for each supported raw or convenience view.
7. Verify live and earlier records converge on stable event identities.
8. Add provider-owned authentication and usage probes where supported.

## Contract tests

Use sanitized fixtures captured from real providers. Cover:

- exact raw preservation;
- provider cursor progress, including an empty first-page token;
- `available` and `unavailable` page results;
- `exact` and `settled` coverage;
- exact projection shapes with raw provenance;
- full-prefix and incremental-projector equivalence;
- stable identity across live and historical reads;
- unknown-record behavior;
- raw delivery when projection fails;
- provider request-ID correlation inside the session driver;
- identical externally observable behavior over daemon TCP and Unix transports.

Provider-specific implementations live in `@monad/atoms`. Wire schemas remain in
`@monad/protocol`; do not redeclare them in the adapter package.
