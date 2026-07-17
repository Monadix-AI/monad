# External Agent History Recovery

## Problem

Stopped managed agents can have durable provider history while the Workplace observation panel shows no history. Three independent assumptions cause the loss:

1. A non-empty bounded `outputSnapshot` is treated as authoritative even when truncation leaves no parseable observation events, so provider history fallback never runs.
2. The client starts history paging only after the current observation contains a timestamped event, so an empty current frame cannot bootstrap recovery.
3. Paged events without timestamps are discarded by the boundary filter, which removes Claude history even when every provider page is readable.

A fourth presentation issue amplifies the first one: when a member has several runtimes, the newest runtime is selected even when it has no observable events and an older runtime has valid history.

## Goals

- Recover provider history when a stored snapshot is present but not observable.
- Allow an empty observation panel to request its first history page.
- Preserve timestamp-less history without duplicating events already shown.
- Prefer the newest observable runtime for a project member while retaining the newest runtime for lifecycle state elsewhere.
- Keep the existing bounded-output and cursor contracts intact.

## Non-goals

- Rewriting already persisted snapshots.
- Synthesizing provider timestamps that do not exist.
- Combining every historical runtime into one continuous provider transcript.
- Changing live external-agent lifecycle or fanout behavior.

## Design

### Server fallback

Observation resolution will distinguish `snapshot exists` from `snapshot is observable`. A stored snapshot remains the first source, but if adapter projection produces zero events and the row has a provider session reference, managed-runtime observation will continue through the existing CLI/local provider-history fallback. A provider result is accepted only when it projects at least one event; otherwise the original snapshot response remains available for diagnostics.

Paged history keeps its existing provider-first and stored-snapshot cursor behavior. The change is limited to the initial stopped-session observation used to establish a usable frame.

### Client bootstrap and boundary handling

History loading will support two modes:

- Timestamp boundary mode: when the current frame has a valid oldest timestamp, keep only history events older than that boundary.
- ID bootstrap mode: when the frame is empty or history events have no timestamp, retain events whose stable IDs are not already present.

The history load scope will require only an external-agent session ID. Deliveries remain excluded. `findOlderObservationPage` will scan cursors until it finds at least one retainable event or exhausts the provider, with cursor-cycle protection unchanged.

History merging will deduplicate by stable event ID. Timestamp comparison remains an optimization and ordering boundary when both sides supply time; missing time is no longer equivalent to invalid history.

### Runtime selection

The rail observation selector will rank matching runtimes in this order:

1. running runtimes;
2. newest runtime with observable items;
3. newest matching runtime.

This fallback applies only when opening a member observation without an explicit runtime ID. Explicit delivery/runtime observations remain pinned to their requested ID.

## Error handling

- Provider fallback failures remain non-fatal and return the stored snapshot response when available.
- Empty provider pages continue paging while a cursor advances; repeated cursors terminate safely.
- History request failures keep the current panel contents and mark pagination exhausted, matching current UI behavior.
- No provider history bytes or raw prompts are added to logs.

## Tests

- Daemon unit test: a non-empty but unparseable Codex snapshot with a provider reference falls back to provider history.
- Daemon unit test: a parseable snapshot remains authoritative and does not spawn fallback work.
- Atom unit test: empty current observation can establish a history load scope.
- Atom unit test: timestamp-less history events survive filtering and are deduplicated by ID.
- Atom unit test: timestamped events still honor the older-than-live boundary.
- Atom unit test: member observation selects the newest observable runtime over a newer empty stopped runtime, while explicit runtime selection remains unchanged.

Focused daemon and atom suites run first. Final verification runs repository lint, typecheck, and test gates according to the repository workflow.
