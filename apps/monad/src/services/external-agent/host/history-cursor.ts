// History-page cursors are opaque to clients but daemon-side they come from two unrelated paging
// schemes: `snapshot:` pages the stored output snapshot by line offset, `provider:` wraps an
// adapter-native cursor (claude message offset, codex turn-id JSON). A cursor must never cross into
// the other scheme — codex rejects a snapshot offset as an invalid cursor, and the stored pager would
// misparse a turn-id — so every emitted cursor is namespaced and every consumer decodes before use.
// An unprefixed or unknown cursor decodes to `none`: paging restarts from the first page instead of
// forwarding a foreign cursor to a provider.
const STORED_HISTORY_CURSOR_PREFIX = 'snapshot:';
const PROVIDER_HISTORY_CURSOR_PREFIX = 'provider:';
const JOURNAL_HISTORY_CURSOR_PREFIX = 'journal:';

export type HistoryCursor = { kind: 'stored' | 'provider' | 'journal'; value: string } | { kind: 'none' };

export function decodeHistoryCursor(before: string | undefined): HistoryCursor {
  if (!before) return { kind: 'none' };
  if (before.startsWith(STORED_HISTORY_CURSOR_PREFIX)) {
    return { kind: 'stored', value: before.slice(STORED_HISTORY_CURSOR_PREFIX.length) };
  }
  if (before.startsWith(PROVIDER_HISTORY_CURSOR_PREFIX)) {
    return { kind: 'provider', value: before.slice(PROVIDER_HISTORY_CURSOR_PREFIX.length) };
  }
  if (before.startsWith(JOURNAL_HISTORY_CURSOR_PREFIX)) {
    return { kind: 'journal', value: before.slice(JOURNAL_HISTORY_CURSOR_PREFIX.length) };
  }
  return { kind: 'none' };
}

export function encodeProviderHistoryCursor(cursor: string): string {
  return `${PROVIDER_HISTORY_CURSOR_PREFIX}${cursor}`;
}
