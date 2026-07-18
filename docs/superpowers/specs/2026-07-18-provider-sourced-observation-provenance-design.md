# Provider-Sourced Observation Provenance

## Status

Approved for implementation on 2026-07-18.

## Goal

Make the provider's live or native-session history the only source of observation data. Monad may persist the mapping needed to locate that native session and may persist chat messages produced while processing contract events, but it must not persist provider raw events, observation contract events, or observation UI projections.

## Invariants

The observation pipeline is strictly:

```text
provider raw events (1..N)
  -> observation contract events (1..N)
  -> UI projection entries (1..N)
```

- Every observation contract event has one or more real provider raw events as provenance.
- Every UI projection entry has one or more observation contract events as provenance.
- No layer may synthesize an event without an upstream source event.
- Derived labels, summaries, and layouts are allowed, but they do not create new source events.
- A stable plain-text or PTY frame is a raw event and may be projected like a structured provider record.
- A provider-native session must be available for stopped-session observation. If it was deleted, cannot be read, or has no supported history reader, reconstruction fails.

## Data Flow

While an agent is live, its bounded in-memory raw buffer feeds temporary contract events. Those events have two consumers:

1. The chat-record generator may produce normal persisted chat messages.
2. The observation projector may produce ephemeral UI entries for users currently observing the agent.

```text
provider live/history raw events
  -> ephemeral contract events
      -> chat-record generator -> persisted chat messages
      -> ephemeral UI projection -> observation UI
```

Persisted chat messages are an independent business record. They remain readable even when the provider-native session is gone, but they must never be used to reconstruct observation history.

## Provenance Contracts

Every observation contract event carries a non-empty raw-event collection:

```ts
type ObservationProvenance = {
  rawEvents: [unknown, ...unknown[]];
};
```

Both the provider-facing observation contract and the neutral `AgentObservationEvent` contract require this provenance. A merged event, such as one thinking run, concatenates the provenance of all events in the run without inventing an envelope.

Every UI timeline entry carries a non-empty contract-event collection:

```ts
type ObservationUiProvenance = {
  contractEvents: [AgentObservationEvent, ...AgentObservationEvent[]];
};
```

A normal card points to one contract event. A paired tool card points to its call and result events. Future aggregate cards may point to more. Raw JSON shown by the UI is derived only from `contractEvents[*].provenance.rawEvents`; it is not an independent UI field or cache.

## Thinking Identity and Merging

Claude assigns a distinct UUID to each raw event, including every `thinking_tokens` update. UUID therefore identifies a raw event, not a thinking run.

- Raw-event deduplication uses each provider UUID when present.
- Consecutive thinking-token events within one generation form one thinking run.
- The merged contract event contains every raw event in that run.
- The first raw event's UUID is the stable identity for the merged run.
- Appending later token events does not change the contract or UI identity.
- One model generation may contain one thinking card; one agent turn may contain several model generations and therefore several thinking cards.

## Persistence Boundary

Monad may persist:

- the Monad session or member to provider-native session reference;
- the provider, agent identity, working context, and other minimal routing data required to read that native session;
- chat messages and their normal business metadata;
- runtime-control metadata unrelated to observation payloads.

Monad must not persist:

- provider raw events or raw output snapshots;
- decoded observation contract events;
- neutral observation events;
- UI observation events, cards, timeline entries, or merged thinking state;
- provider history pages or cursors as a local fallback cache.

The existing `external_agent_sessions.output_snapshot` persistence and `external_agent_observation_events` journal violate this boundary. Implementation removes their writes, reads, fallback behavior, and stored payloads. Existing persisted observation payloads are deleted rather than migrated.

An in-memory live buffer remains allowed. It is bounded, belongs to the active runtime, is never flushed to SQLite, and is discarded when the live runtime ends.

## Live Observation

For an active provider runtime:

1. Read provider frames from the live transport.
2. Keep only a bounded in-memory buffer needed to project the current live frame.
3. Decode raw frames to provenance-bearing contract events.
4. Generate persisted chat records when applicable.
5. Generate ephemeral UI frames for active observation subscribers.

The live raw buffer is not a durable history source. A daemon restart must use the provider-native session mapping and provider history API to reconstruct observation.

## Stopped-Session Observation

For a stopped runtime:

1. Resolve the stored provider-native session reference.
2. Invoke the adapter's provider history reader with provider-native pagination.
3. Decode the returned raw records into contract events.
4. Project contract events into the requested UI frame.

Only provider-native cursors are valid. Stored-snapshot and observation-journal cursors are removed.

If the mapping is absent, the provider-native session was deleted, the adapter lacks history support, or provider history returns an error or unavailable result, Monad returns observation `unavailable`. It does not fall back to chat messages, output snapshots, journals, or synthesized placeholders.

## Synthetic Events

The Claude history reader currently creates a `system:init` record from session metadata. That record is not a provider history event and must be removed.

The same rule applies to every adapter and daemon projector: metadata may help route or classify real events, but it may not be emitted as a contract event by itself. Monad-native observation remains valid when its raw source is a real Monad domain event. Publish-only domain events are valid only when they exist on the live domain-event bus; the observation projector must not infer replacements for missing events.

## Plain-Text Providers

A provider without structured envelopes may still support live observation. The adapter defines a stable frame boundary, and the exact original string frame becomes the raw provenance event. The contract projector may derive kind, text, and tool fields from it.

If that provider cannot later read its native-session history, observation becomes unavailable after the live runtime ends. Monad does not persist the text frames to compensate.

## Failure Semantics

Reconstruction failures are explicit observation availability failures, not empty timelines and not transport-generated pseudo-events. The response distinguishes at least these internal causes while keeping the public contract stable:

- native-session mapping missing;
- provider-native session unavailable or deleted;
- provider history unsupported;
- provider history read failed.

Chat history remains available independently. Observation availability never controls whether persisted chat messages can be read.

## Migration

Implementation will:

- stop flushing live output buffers to SQLite;
- remove persisted output snapshots from external-agent session views and storage paths;
- remove observation-journal inserts and reads;
- remove journal and stored-snapshot history cursors;
- delete provider-history fallback to locally stored payloads;
- remove the synthetic Claude history `system:init` record;
- delete existing persisted raw snapshots and observation-journal rows;
- update the existing observation-layering proposal, whose current persistence decision says raw snapshots are stored;
- preserve only the native-session mapping and non-observation runtime metadata needed for routing and control.

## Verification

Tests must prove:

- contract schemas reject events with empty or absent raw provenance;
- a structured raw event produces contract provenance containing that exact event;
- a plain-text frame produces provenance containing that exact string;
- multiple thinking-token events merge into one stable event whose provenance contains all raw events;
- adding a thinking-token event does not change the merged run identity;
- a single UI card carries one contract event and a tool pair carries two;
- Raw JSON is derived from contract provenance only;
- Claude history does not synthesize `system:init`;
- stopped-session observation reads provider-native history on every request;
- a deleted or unreadable provider-native session returns unavailable even when persisted chat messages exist;
- daemon restart reconstruction uses only the native-session mapping and provider history;
- no runtime path writes raw snapshots, contract events, or UI events to SQLite;
- the obsolete observation journal and stored snapshot data are removed by migration;
- live observation continues to work from the bounded in-memory buffer.

All affected provider adapters, TCP and Unix daemon transports, history pagination, and observation UI projections must retain equivalent behavior under this source-of-truth change.
