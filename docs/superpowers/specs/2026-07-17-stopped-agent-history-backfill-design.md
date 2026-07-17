# Stopped Agent History Backfill

## Problem

A stopped Workplace external-agent runtime can retain valid provider history while its observation panel cannot load it. Two gates combine to hide the history:

1. The client creates a history-load scope only for live observation frames carrying an observation epoch and provider checkpoint. A stopped frame has state `history`, so it never sends the initial history-page request.
2. The daemon treats any non-empty stored output snapshot as authoritative. A bounded snapshot can begin inside one oversized JSON record and project to zero events, yet still prevent the existing provider-history fallback from running.

Codex app-server control responses can be large single-line JSON records, which makes this failure persistent when such a record fills the bounded snapshot.

## Goals

- Let stopped/history frames bootstrap their first history page without a live checkpoint.
- Preserve checkpoint-based reconciliation and deduplication for live frames.
- Treat a stored snapshot as usable history only when it projects observable events.
- Fall back to provider history when a non-empty snapshot projects zero events.
- Prevent app-server control responses from polluting the observation snapshot.
- Preserve existing provider cursors and stored-snapshot cursors.

## Non-goals

- Rewriting already persisted snapshots.
- Combining multiple external-agent runtimes into one transcript.
- Changing runtime selection, lifecycle, fanout, or delivery observation behavior.
- Synthesizing provider timestamps or provider event identities.

## Design

### Client bootstrap

History loading has two modes:

- Live mode keeps the current observation epoch and provider checkpoint requirements. The checkpoint locates the overlap between provider history and the bounded live observation tail.
- Stopped mode requires only the external-agent session ID. Its first history-page response is canonical history, so it can load without a live checkpoint.

Delivery observations remain excluded. Subsequent pages continue using the returned cursor. Merging keeps stable event-ID deduplication so a stopped snapshot and provider page cannot display the same event twice.

### Daemon fallback

For a stopped runtime, the daemon first projects the stored snapshot. A history result with at least one projected event remains authoritative and avoids provider work.

If the snapshot is empty or projects zero events and the row is a managed runtime with a provider session reference, the resolver continues through the existing provider sources:

1. provider app-server history request;
2. provider-local history file fallback.

A provider result is accepted only when it projects at least one event. If every provider source fails or remains unobservable, the daemon returns the original snapshot response for diagnostics rather than replacing it with another empty result.

The history-page handler applies the same observability rule: an empty stored page must not terminate recovery when provider history is available.

### Recurrence prevention

App-server JSON-RPC control responses are parsed for request completion but are not appended to the observation snapshot. Observable provider notifications remain newline-framed before entering the bounded buffer. This prevents a large control response from becoming the only retained, mid-record snapshot fragment.

## Error Handling

- Provider fallback errors remain non-fatal when a stored snapshot exists.
- Provider output that projects zero events is ignored as a recovery source.
- Cursor cycles and exhausted pages terminate with an empty page rather than looping.
- No provider history payloads, prompts, or raw records are added to logs.

## Tests

- Daemon: a stopped managed Codex runtime with a non-empty unparseable snapshot falls back to provider history.
- Daemon: a parseable snapshot remains authoritative and does not invoke provider fallback.
- Daemon/history page: an empty stored projection continues to provider history.
- Atom helper: a stopped external-agent observation can establish a history-load scope without a checkpoint.
- Atom helper: live mode still requires and reconciles through its checkpoint.
- Atom helper: merged history deduplicates stable event IDs.
- Output pipeline: app-server control responses resolve requests without entering the observation buffer.
- Existing TCP loopback and Unix-socket route coverage must continue to pass for the daemon history endpoint.

## Acceptance Criteria

The affected stopped Codex runtime can load observable provider events even though its persisted 256 KiB snapshot projects zero events. Existing live history backfill still starts from its provider checkpoint, valid stopped snapshots keep the fast path, and app-server control responses no longer recreate the corrupt-snapshot condition.
