# External Agent Event Source Design

## Goal

Expose every external agent through one provider-neutral event stream contract. History acquisition, live wire decoding, provider cursors, and event identity belong to the adapter. Daemon, client, and UI consume only normalized events and opaque pagination cursors.

## Contract Boundary

An adapter projects every provider event into an `ExternalAgentObservationEvent` envelope. Projection is intentionally best effort:

- Recognized events use a normalized role, text, source, activity metadata, and optional structured fields.
- Unrecognized events are not dropped. They use the shared `unknown` classification and retain the original payload in `raw`.
- Every event has a stable `dedupeKey` that is identical when the same provider event is encountered through live delivery and history backfill.
- Provider cursors remain opaque outside the adapter and daemon pagination boundary.

The generic UI may render, collapse, or hide an unknown event according to shared product rules. It must not inspect provider-specific fields or branch on provider names. A future provider-specific renderer must be registered behind an adapter-owned extension contract rather than embedded in generic UI code.

## Adapter Event Source

Each `ExternalAgentProviderAdapter` exposes one event source with two responsibilities:

1. Project live provider frames into normalized events, including unknown envelopes for unsupported records.
2. Read historical pages and return the same normalized event contract with a provider cursor.

Adapters may normalize only a subset of provider event types, but they must preserve cardinality at the provider-record boundary: every input record either contributes to a recognized event or produces an unknown event. Records intentionally absorbed into a recognized group are covered by that group's raw payload and stable identity.

## Daemon Responsibilities

The daemon coordinates the event source without knowing provider formats:

- maintain a normalized live tail;
- persist normalized events in a bounded journal;
- deduplicate live and historical observations by `dedupeKey`;
- wrap adapter cursors in an opaque daemon cursor;
- expose current-frame, subscribe, and page operations over both TCP loopback and Unix socket;
- pass unknown events through unchanged.

The daemon must not call provider-specific history hooks, inspect `raw`, or branch on provider identifiers.

## Client and UI Responsibilities

Clients validate event frames at the protocol boundary and merge pages by `dedupeKey`. The UI consumes only normalized fields:

- recognized events use the existing neutral card model;
- unknown events use one generic fallback policy;
- diagnostics may display serialized `raw` data, but may not derive provider semantics from it;
- pagination starts from `historyBefore` and treats all cursor values as opaque.

## Failure Semantics

History reads return a discriminated result: available, unsupported, not found, or temporarily unavailable. Live projection failures produce an unknown event containing the original payload and safe diagnostic metadata instead of dropping the event or terminating the stream. Invalid wire frames are rejected at transport boundaries.

## Verification

Conformance tests cover all six built-in adapters: Codex, Claude Code, Gemini, Qwen, OpenClaw, and Hermes. Tests prove:

- recognized live and history events share `dedupeKey` values;
- unrecognized fixtures produce unknown events with retained raw payloads;
- generic daemon and UI code contain no provider-specific raw parsing;
- pagination cursors remain opaque;
- current, subscribe, and page behavior match over TCP and Unix socket;
- persistence deduplicates overlapping live and backfill observations.

