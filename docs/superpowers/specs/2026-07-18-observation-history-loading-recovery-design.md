# Observation history loading recovery

## Problem

The Workplace observation panel has two related loading-state failures.

First, prepending provider history can regroup the boundary rows. When that removes the previous first row key, `useFirstItemIndex` resets to its base index. React Virtuoso deduplicates `startReached` by index, so reaching the top again does not request the next page even though the UI still says “Scroll up to load earlier”.

Second, a stopped external-agent session is rendered before its asynchronous observation SSE emits the provider-history frame. During that gap, the panel derives an empty stopped state from the session-list snapshot and shows “Agent currently not running”. The card is not provider history and disappears when backfill completes. Pagination failures are also converted silently into an exhausted state, leaving no error or retry action.

## Goals

- Preserve the virtual viewport and keep `startReached` re-armed when prepend regrouping changes the old first row key.
- Show an explicit loading state while a stopped session waits for its first observation frame.
- Never render the stopped empty-state placeholder while provider history is still being resolved.
- Distinguish history exhaustion from history-loading failure and provide an in-place retry.
- Preserve current live-session rendering and provider cursor contracts.
- Preserve the projection boundary: the UI never synthesizes contract events, and the contract layer never synthesizes raw provider events.

## Design

### Stable prepend index

The first-item-index state will retain the previous row identities, not only the previous first identity. After a list update it will find the earliest previous row that still exists in the new list and compute the net number of rows inserted before that survivor. The virtual index decreases by that net offset.

If the complete list is replaced and no previous identity survives, the state resets to the established base index. This keeps session switches safe while handling boundary regrouping without relying on total list length.

### Observation bootstrap state

The rail will preserve the RTK observation value's initial `null` instead of collapsing it into `undefined`. For a stopped external-agent session, `null` means the first observation frame is still resolving. The panel will render its normal agent header plus a dedicated “Loading history…” body outside the observation timeline and will not render session-list-derived items or the stopped empty state during this phase.

Running sessions continue to use their current live stream immediately. Once the first frame arrives, `history`, `live`, and `unavailable` frames retain their existing projections.

Loading and unavailable are UI state, not observation events. The client will not insert a `system`, `status`, or any other placeholder item into `stream.items`. The unavailable empty state may render only after the daemon explicitly returns an `unavailable` frame; an empty or absent frame is not evidence of unavailability. No raw record is created for loading, unavailable, or retry UI.

The client stream already exposes `onError`. A fatal bootstrap error will publish an unavailable frame so loading cannot remain permanent. Transient stream errors keep the loading or last-good frame while the existing reconnect loop runs.

### Paging error and retry

Observation history page state will represent loading, exhausted, and error independently. A failed page keeps all currently rendered items and the cursor that failed. The history header will show a localized failure message with a retry button. Retrying requests the same cursor; success clears the error and resumes normal pagination.

Only a successful response without `nextCursor` marks the history exhausted and shows “Start of history”.

## Tests

- The first-item-index reducer retains a decreasing index when the old first row disappears but a later old row survives.
- A wholesale replacement with no surviving row resets to the base index.
- A stopped observation with no first SSE frame renders loading and does not render the stopped empty state.
- Pending, unavailable, and retry UI add no items to the observation timeline and no raw records.
- A resolved history frame replaces loading with provider events.
- A failed history page retains the cursor and items, exposes retry state, and is not marked exhausted.
- Retrying the failed cursor and receiving a page resumes pagination.
- Existing virtual-list bottom-settlement changes already present on `main` remain intact.

## Non-goals

- Changing provider history formats or cursor encoding.
- Persisting backfilled provider history in SQLite.
- Remounting the virtual list for every page.
- Treating transient SSE reconnects as permanent history failures.
