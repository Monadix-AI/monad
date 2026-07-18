# Provider-Sourced Observation Provenance

## Status

Revised on 2026-07-18; pending written-spec review.

## Goal

Make the provider's live transport or native-session history the only source of observation data. Monad may persist the mapping needed to locate that native session and may persist chat messages produced while processing contract events. It must not durably persist provider raw events, observation contract events, or observation UI projections.

While a native runtime is connected, Monad uses an ephemeral live raw store as the lossless recovery source for client refreshes. This closes the period in which the native session is still running but provider history cannot yet backfill its current events. An optional fixed-size memory cache may accelerate reads, but correctness must not depend on it. The live store is deleted when that runtime disconnects, is never used after daemon restart, and cannot replace stopped-session provider history backfill.

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

While an agent is live, every transport frame is appended losslessly to an ephemeral live raw store before it becomes observable. A fixed-size decode window reads those frames and feeds temporary contract events. Those events have two consumers:

1. The chat-record generator may produce normal persisted chat messages.
2. The observation projector may produce ephemeral UI entries for users currently observing the agent.

```text
provider live frames -> ephemeral live raw store ---> ephemeral contract events
                         + optional memory cache       -> chat-record generator -> persisted chat messages
                                                       -> ephemeral UI projection -> observation UI

provider stopped-session history --------------------> ephemeral contract events
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

During one connected native-runtime epoch, Monad temporarily writes:

- the exact provider frames received from the live transport;
- storage framing metadata such as byte ranges, source stream, and receive order, provided it cannot be projected as an event by itself.

This temporary store is the authoritative live recovery source for that runtime epoch. It supports client refresh, reconnect, and pagination while the native runtime remains connected. It is not durable observation history and must not survive the runtime epoch as an available data source.

Monad must not durably persist or cache:

- provider raw events or raw output snapshots outside the connected runtime epoch's live store;
- decoded observation contract events;
- neutral observation events;
- UI observation events, cards, timeline entries, or merged thinking state;
- provider history pages or cursors as a local fallback cache.

The existing `external_agent_sessions.output_snapshot` persistence and `external_agent_observation_events` journal violate this boundary. Implementation removes their writes, reads, fallback behavior, and stored payloads. Existing persisted observation payloads are deleted rather than migrated.

The baseline live store is a dedicated temporary SQLite database, separate from the durable Monad application database. It lives in a private runtime directory, is excluded from backups and indexes, and uses owner-only directory and file permissions. It does not require cross-process crash durability because daemon restart recovery from it is forbidden.

Every accepted frame is committed to the live store before Monad publishes it as observable. The store retains the exact original frame bytes or string together with non-event framing metadata. Projection must parse from that preserved value rather than reserialize a decoded object.

Monad keeps only fixed-size in-memory state for decoding incomplete frames and applying write backpressure. The baseline does not add a raw-event read cache: client refresh reads the temporary database directly. A fixed-size hot-range cache may be added only after measurement proves it necessary; it can contain only already committed rows, is never the only copy of a frame, and cannot change results. Neither cached raw data nor projected events may accumulate with session length.

The system must not evict accepted raw frames to satisfy a quota. When storage cannot accept another complete frame, Monad applies backpressure. If the write cannot succeed, it reports a live-observation storage failure and stops or disconnects the native runtime rather than continuing with a lossy observation stream.

On graceful stop, process exit, or transport disconnect, Monad closes and deletes the runtime epoch's live store synchronously. A daemon crash can leave files behind, but startup treats every pre-existing live store as stale and removes it asynchronously. Startup cleanup never exposes stale data to observation requests.

## Provider History Capabilities

History support is an explicit adapter capability rather than an assumption inferred from the presence of a JSONL file:

```ts
type ProviderHistoryCapability = {
  stoppedRead: 'authoritative' | 'best-effort' | 'unsupported';
  activeRead: 'authoritative' | 'best-effort' | 'unsupported';
  includesTransientEvents: boolean;
};
```

- `authoritative` means the provider documents a stable read contract and cursor semantics for that lifecycle state.
- `best-effort` may be used for diagnostics or stopped-session fallback projection, but it cannot replace the connected runtime's lossless live store.
- `includesTransientEvents` is true only when active history can reproduce live-only deltas such as thinking-token updates and command-output fragments.

Codex App Server currently supports reading stored active threads, but its turn and item pagination methods are experimental and persisted items do not replace live delta notifications. Claude Agent SDK `getSessionMessages` reconstructs a conversation chain rather than returning every raw transcript event; it cannot reproduce the complete observation stream. Direct Codex or Claude JSONL reads therefore remain provider-specific, best-effort readers unless the provider supplies a stronger contract.

Active provider history may supplement the live store for reconciliation or diagnostics. It does not replace live capture: all connected runtimes use the same lossless live-store path so client-refresh semantics do not vary by provider.

## Live Observation

For an active provider runtime:

1. Read provider frames from the live transport.
2. Commit each complete raw frame, unchanged, to the runtime epoch's live store.
3. Apply backpressure through a fixed-size write queue; never grow memory with output length or drop an accepted frame.
4. Optionally populate a fixed-size read cache from committed frames.
5. Decode committed raw frames to provenance-bearing contract events.
6. Generate persisted chat records when applicable.
7. Generate ephemeral UI frames for active observation subscribers.

The live recovery reader serves an internally consistent snapshot of the committed store plus any equivalent cached rows. Client refresh and live-history pagination use an epoch-scoped local cursor and must reproduce every accepted raw frame exactly once. Cache presence or eviction cannot change the result.

The live store is not a durable history source. A daemon restart must discard stale stores and use the provider-native session mapping and provider history reader to reconstruct observation. A live epoch cursor becomes invalid when its runtime disconnects; later observation starts a new provider-history query rather than translating or persisting that cursor.

Provider refresh reads may supplement reconciliation while the runtime is active, but they do not replace captured live frames. Deduplication uses real provider identities such as UUIDs or item identifiers; the local storage sequence is framing metadata and never becomes a contract event identity.

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

If that provider cannot later read its native-session history, observation becomes unavailable after the live runtime ends. Monad does not durably persist the text frames to compensate.

While the runtime remains connected, those text frames use the same ephemeral live store as structured providers. Disconnect still deletes them.

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
- replace the session-length in-memory raw buffer with a lossless ephemeral live raw store and fixed-size decode/write state;
- use a dedicated temporary SQLite database as the baseline live-store implementation;
- keep raw-event read caching out of the baseline and permit only a measured, removable cache of already committed frames;
- add epoch-scoped live cursors and consistent client-refresh reads;
- add synchronous per-runtime live-store deletion and asynchronous startup cleanup of stale files;
- add bounded write backpressure and fail-closed handling for live-store write failure;
- declare active and stopped history capabilities on provider adapters;
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
- stale live-store files are deleted on startup and are never exposed to reconstruction;
- graceful stop, process exit, and transport disconnect delete the matching runtime epoch's live store;
- the live write queue and decoder remain within fixed memory bounds under arbitrarily long output;
- every accepted frame is committed unchanged before publication and survives client refresh while the runtime is connected;
- client refresh reconstructs an exact, duplicate-free snapshot from the live store regardless of memory-cache state;
- removing or disabling the memory cache does not change observation output;
- storage pressure never evicts accepted frames; an unrecoverable write failure stops the runtime rather than losing observation data;
- active provider-history availability does not bypass live capture;
- Claude `getSessionMessages` is not treated as complete raw observation history;
- direct JSONL readers are classified as best-effort unless backed by an explicit provider contract;
- no runtime path writes raw snapshots, contract events, or UI events to the durable Monad application SQLite database;
- the obsolete observation journal and stored snapshot data are removed by migration;
- live observation and client refresh continue to work from the ephemeral live store with bounded memory.

All affected provider adapters, TCP and Unix daemon transports, history pagination, and observation UI projections must retain equivalent behavior under this source-of-truth change.
