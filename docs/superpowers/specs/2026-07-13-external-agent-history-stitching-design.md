# External Agent History Stitching Design

## Goal

Render `Show history` only when a projected history item exists before the live timeline, then prepend older pages in chronological display order without ID-based deduplication.

## Data flow

The UI treats the earliest timestamped live observation as the seam. It probes history pages from newest to oldest, discards items at or after that seam, and keeps following opaque cursors until it finds an older item or exhausts history. A found page is retained but hidden until the user selects `Show history`; subsequent pages are prepended when the list reaches the top.

The daemon remains a raw transport. It does not assign transaction IDs or interpret provider transaction identity. Provider and stored-history cursors remain opaque to the client.

## Ordering

History requests traverse newest pages toward older pages. Provider adapters return each accepted page in oldest-to-newest presentation order, so the page can be prepended as a whole. Pages do not overlap the live window because the seam filter removes observations whose timestamp is greater than or equal to the earliest live timestamp.

Untimestamped status observations are not used as backfill seam candidates and are not inserted across the seam. They remain available in the current live projection.

## Availability

The button is hidden while probing. It appears only after a page containing at least one observation older than the live seam has been retained. Empty, unsupported, failed, or exhausted probes leave it hidden.

## Pagination

The retained page carries the server's `nextCursor`. Reaching the top requests that cursor, prepends the next older chronological page, and continues until no cursor remains.

## Verification

Pure pagination tests cover seam filtering, direct prepend ordering, and empty-page cursor traversal. Lily's session is the manual fixture: its current observation already contains both turns, so probing its stored snapshot must exhaust without exposing `Show history` or duplicating events.
