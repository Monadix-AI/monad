# Provider-Sourced Observation Provenance

## Status

Revised on 2026-07-18; pending written-spec review.

## Goal

Make the provider's live transport or native-session history the only source of observation data. Monad may persist the mapping needed to locate that native session and may persist chat messages produced while processing contract events. It must not durably persist provider raw events, observation contract events, or observation UI projections.

While a native runtime is connected, Monad may use an ephemeral raw transport spool to bound memory without losing live frames. The spool is not a history source: it is deleted when that runtime disconnects, is never used after daemon restart, and cannot replace provider history backfill.

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

While an agent is live, its transport frames are appended to an ephemeral raw spool unless the adapter exposes authoritative active history containing transient events. A fixed-size decode window reads the selected live source and feeds temporary contract events. Those events have two consumers:

1. The chat-record generator may produce normal persisted chat messages.
2. The observation projector may produce ephemeral UI entries for users currently observing the agent.

```text
provider live frames -> ephemeral raw spool ---------> ephemeral contract events
provider authoritative active history --------------> ephemeral contract events
                                                       -> chat-record generator -> persisted chat messages
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

During one connected native-runtime epoch, Monad may temporarily write:

- the exact provider frames received from the live transport;
- storage framing metadata such as byte ranges, source stream, and receive order, provided it cannot be projected as an event by itself.

This temporary spool is transport buffering, not durable observation persistence. It must not survive the runtime epoch as an available data source.

Monad must not durably persist or cache:

- provider raw events or raw output snapshots outside the connected runtime epoch's spool;
- decoded observation contract events;
- neutral observation events;
- UI observation events, cards, timeline entries, or merged thinking state;
- provider history pages or cursors as a local fallback cache.

The existing `external_agent_sessions.output_snapshot` persistence and `external_agent_observation_events` journal violate this boundary. Implementation removes their writes, reads, fallback behavior, and stored payloads. Existing persisted observation payloads are deleted rather than migrated.

The spool must not use SQLite or another application database. It lives in a private runtime directory, is excluded from backups and indexes, and uses owner-only directory and file permissions. It does not require `fsync` because crash recovery from it is forbidden.

Monad keeps only fixed-size in-memory state for decoding incomplete frames, indexing the current segment, and applying write backpressure. Neither the raw stream nor projected events may accumulate with session length.

Each session and the daemon as a whole have hard spool quotas. Quota enforcement removes only complete raw frames or segments. Older observation may instead be read from provider history; when neither spool nor provider history contains it, Monad reports that observation range as unavailable rather than manufacturing a replacement event.

On graceful stop, process exit, or transport disconnect, Monad closes and deletes the runtime epoch's spool synchronously. A daemon crash can leave files behind, but startup treats every pre-existing spool as stale and removes it asynchronously. Startup cleanup never exposes stale spool data to observation requests.

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
- `best-effort` may be used for diagnostics or fallback projection, but it cannot justify deleting live spool data that has no authoritative provider copy.
- `includesTransientEvents` is true only when active history can reproduce live-only deltas such as thinking-token updates and command-output fragments.

Codex App Server currently supports reading stored active threads, but its turn and item pagination methods are experimental and persisted items do not replace live delta notifications. Claude Agent SDK `getSessionMessages` reconstructs a conversation chain rather than returning every raw transcript event; it cannot reproduce the complete observation stream. Direct Codex or Claude JSONL reads therefore remain provider-specific, best-effort readers unless the provider supplies a stronger contract.

An adapter with authoritative active history that includes transient events may read the provider directly instead of creating a spool. This is an optimization of the live source, not a separate fallback source. All other adapters use the spool while connected.

## Live Observation

For an active provider runtime:

1. Read provider frames from the live transport.
2. If the adapter has authoritative active history including transient events, read observation pages from that provider interface. Otherwise append the exact frames to the runtime epoch's spool.
3. Apply backpressure through a fixed-size write queue; never grow memory with output length.
4. Decode raw frames to provenance-bearing contract events.
5. Generate persisted chat records when applicable.
6. Generate ephemeral UI frames for active observation subscribers.

The live spool is not a durable history source. A daemon restart must discard stale spools and use the provider-native session mapping and provider history reader to reconstruct observation.

Provider refresh reads may be used to serve settled or older ranges while the runtime is active. They do not replace spool frames until the adapter can prove that the provider copy is authoritative for those exact source events. Deduplication uses real provider identities such as UUIDs or item identifiers; Monad does not synthesize identity events.

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

While the runtime remains connected, those text frames may use the same ephemeral spool as structured providers. Disconnect still deletes them.

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
- replace the session-length in-memory raw buffer with an ephemeral, segmented raw transport spool and fixed-size decode/write state;
- add synchronous per-runtime spool deletion and asynchronous startup cleanup of stale spool files;
- add per-session and global spool quotas plus write backpressure;
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
- stale spool files are deleted on startup and are never exposed to reconstruction;
- graceful stop, process exit, and transport disconnect delete the matching runtime epoch's spool;
- the live write queue and decoder remain within fixed memory bounds under arbitrarily long output;
- per-session and global spool quotas cannot remove partial frames or create replacement events;
- quota loss without provider coverage returns an unavailable range;
- only an adapter with authoritative active history including transient events may skip the live spool;
- Claude `getSessionMessages` is not treated as complete raw observation history;
- direct JSONL readers are classified as best-effort unless backed by an explicit provider contract;
- no runtime path writes raw snapshots, contract events, or UI events to SQLite;
- the obsolete observation journal and stored snapshot data are removed by migration;
- live observation continues to work from the ephemeral spool with bounded memory.

All affected provider adapters, TCP and Unix daemon transports, history pagination, and observation UI projections must retain equivalent behavior under this source-of-truth change.
