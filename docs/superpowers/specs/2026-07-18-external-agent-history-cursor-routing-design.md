# External-Agent History Cursor Routing Design

## Goal

Prevent local history offsets from reaching provider-native pagination APIs while preserving paging across live and stopped external-agent sessions.

## Cursor ownership

- `live:` belongs to the current ephemeral observation epoch.
- `provider:` wraps an opaque cursor returned by the provider API.
- `snapshot:` wraps an offset returned by the adapter's local history fallback.

A cursor may only return to the pager that produced it.

## Routing

The external-agent host selects the history reader from the decoded cursor kind:

- `live:` pages the live raw store.
- `provider:` calls the provider bridge and forwards only the unwrapped opaque value.
- `snapshot:` calls the adapter without a provider bridge so its local fallback handles the unwrapped offset.
- No cursor first attempts provider history when available, then falls back locally. Provider results emit `provider:`; local results emit `snapshot:`.

The same routing applies whether the runtime is currently live or only represented by its durable session row.

## Failure behavior

Provider errors remain visible. The host must not silently restart pagination or discard an invalid cursor. The fix prevents foreign cursors from being created instead of masking failures.

## Verification

- A regression starts with local Codex history that has more than one page.
- Its first page returns `snapshot:100`, not `provider:100`.
- Supplying that cursor reads the second local page without invoking the provider bridge.
- Existing provider opaque-cursor and live-epoch tests remain green.
