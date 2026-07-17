# Stopped Provider History Pagination Design

## Problem

Stopped managed Codex runtimes currently recover history by starting a short-lived app-server, requesting one
`thread/turns/list` page, flattening that page into text, and then paging the flattened text as if it were a durable
chronological snapshot.

That loses the provider cursor and reverses the meaning of pagination:

- the Codex page is requested with `sortDirection: 'desc'`, so its turns arrive newest first;
- `codexHistoryPageOutput` preserves that provider order when it serializes the turns;
- the stored-output pager takes the tail first and then moves backward through the serialized lines;
- the UI treats every `nextCursor` page as older and prepends it.

For the affected runtime this produces an apparently paged history whose first page contains the oldest records and
whose later pages become newer. It also exposes only the first provider page (20 turns), even though the provider
returned a cursor for older turns.

## Goal

Stopped managed runtimes with a paged provider bridge must use the same history contract as live runtimes:

1. the initial request returns the provider's newest page;
2. each returned page is presented in chronological order within the page;
3. `nextCursor` requests an older provider page;
4. prepending an older page preserves chronological order across the complete UI timeline;
5. provider cursors remain namespaced as `provider:*` and are never converted into `snapshot:*` offsets.

The fix must preserve the existing stored-output fallback for providers or sessions that cannot open a paged bridge.

## Chosen Approach

Add a one-shot provider page bridge for stopped sessions.

The bridge will reuse the existing supervised app-server startup and handshake logic, but it will accept the current
`ExternalAgentHistoryPageRequest` and resolve the native provider page instead of flattening it to one output string.
The host will normalize that provider page through the existing adapter presentation hook and return its native cursor
through `encodeProviderHistoryCursor`.

This is preferred over reading Codex rollout files directly because provider paging already owns turn boundaries,
compaction semantics, and cursor stability. It is preferred over a UI append special case because append would leave
the 20-turn truncation in place and would make UI behavior depend on a provider-specific ordering accident.

## Data Flow

For a stopped managed session with `providerSessionRef`:

1. Decode the client cursor.
2. If the cursor is absent or `provider:*`, launch the provider's app-server bridge.
3. Initialize/resume the provider thread using the existing adapter lifecycle.
4. Request one history page with the decoded provider cursor, requested limit, sort direction, and item view.
5. Preserve `items` and `nextCursor` as a provider page result.
6. Before adapter presentation, reverse the provider items when `sortDirection === 'desc'`. This matches the existing
   live-session presentation path: transport paging remains newest-to-oldest while each UI page is chronological.
7. Convert the page with `historyPageOutput`, normalize it to observation events, and return `provider:*` cursor state.
8. The UI prepends each subsequent older page using its existing stable-ID/provider-identity deduplication.

If the bridge cannot be launched, resumed, or paged, the host falls through to the existing snapshot/provider-output
recovery path. A provider protocol error must not be silently relabeled as exhaustion once a bridge request has begun.

## Components

### One-shot history bridge

`history-backfill.ts` will expose a page-oriented operation alongside the existing output-oriented compatibility
operation. Shared process startup, handshake, timeout, cleanup, and structured-output parsing must remain in one
implementation so the two paths cannot drift.

### Host page resolution

`ExternalAgentHost.storedHistoryPage` will try the stopped provider page bridge before flattening history into stored
output. It will only forward decoded provider cursors to the provider. Snapshot cursors continue directly through the
stored-output pager.

### Provider page presentation

`providerHistoryPageResponse` will normalize descending provider pages to chronological presentation before calling
the adapter's `historyPageOutput`. The live path and stopped path must share the same ordering helper.

### UI

No provider-specific UI branch is added. `findOlderObservationPage` and `prependObservationHistory` retain the contract
that `nextCursor` means an older page.

## Error Handling

- Missing provider ref, adapter paging support, enabled agent, or app-server launch support: return no bridged page and
  use the existing fallback.
- Handshake timeout, process exit, malformed provider response, or response-id mismatch: clean up the child process and
  fall back only when no valid provider page was established.
- Provider `nextCursor` absent: return the page without a cursor; the UI marks history exhausted.
- Foreign or malformed cursor prefix: preserve current behavior and restart from the first page rather than forwarding
  it to the provider.

## Tests

Add regression coverage that fails against the current implementation:

1. a stopped runtime receives the caller's decoded provider cursor in the one-shot app-server request;
2. the response preserves the provider cursor and returns it as `provider:*`;
3. a descending provider page is presented oldest-to-newest within the page;
4. the next provider page contains older turns and prepending it yields one chronological sequence;
5. a snapshot cursor never enters the provider bridge;
6. bridge unavailability retains the current stored-output fallback;
7. TCP loopback and Unix-socket transport tests exercise identical history behavior where the existing fixture supports
   stopped managed runtimes.

## Non-goals

- Reconstructing provider turns from raw rollout JSONL.
- Combining separate external-agent runtime IDs into one observation stream.
- Changing session transcript pagination.
- Adding a provider-specific append mode to the UI.
- Caching or pooling one-shot provider processes in this fix.
