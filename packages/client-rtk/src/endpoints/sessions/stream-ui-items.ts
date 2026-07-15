import type { SessionId, SessionUiEvent, UIItem } from '@monad/protocol';

import { clientOf } from '../../endpoint-helpers.ts';
import { sendMessageApi } from './send-message.ts';

export interface SessionUiStreamState {
  items: UIItem[];
  /** Oldest message id in the (bounded) live window — the `before` cursor for loading older history. */
  oldestCursor?: string;
  /** True when older messages exist before the live window (so the client can page history). */
  hasMore?: boolean;
  /** Advances when the daemon replaces the authoritative transcript after a restore or reset. */
  replacementRevision?: number;
  streamError?: { kind: 'fatal' | 'transient'; status?: number };
}

function keyOf(item: UIItem): string {
  return `${item.kind}:${item.id}`;
}

/** `kind:id → array position`, kept in sync with `items` so per-token upserts are O(1) instead of a
 *  linear `findIndex` scan over the whole transcript (which, run once per streamed token, is O(n²)). */
export function buildIndex(items: UIItem[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < items.length; i++) index.set(keyOf(items[i] as UIItem), i);
  return index;
}

export function applyUiEvent(draft: SessionUiStreamState, event: SessionUiEvent, index: Map<string, number>): void {
  if (draft.streamError) draft.streamError = undefined;
  if (event.kind === 'snapshot') {
    draft.items = event.items;
    draft.oldestCursor = event.oldestCursor;
    draft.hasMore = event.hasMore ?? false;
    if (event.replacesTranscript) {
      draft.replacementRevision = (draft.replacementRevision ?? 0) + 1;
    }
    index.clear();
    for (let i = 0; i < event.items.length; i++) index.set(keyOf(event.items[i] as UIItem), i);
    return;
  }
  if (event.kind === 'upsert') {
    const key = keyOf(event.item);
    const at = index.get(key);
    if (at !== undefined) draft.items[at] = event.item;
    else index.set(key, draft.items.push(event.item) - 1);
    return;
  }
  // Removal shifts positions; rebuild the index (rare relative to upserts).
  draft.items = draft.items.filter((item) => item.kind !== event.target.kind || item.id !== event.target.id);
  index.clear();
  for (let i = 0; i < draft.items.length; i++) index.set(keyOf(draft.items[i] as UIItem), i);
}

const streamUiItemsApi = sendMessageApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    streamUiItems: builder.query<SessionUiStreamState, SessionId>({
      queryFn: () => ({ data: { items: [], hasMore: false, replacementRevision: 0 } }),
      async onCacheEntryAdded(
        sessionId: SessionId,
        {
          cacheDataLoaded,
          cacheEntryRemoved,
          updateCachedData,
          extra
        }: {
          cacheDataLoaded: Promise<unknown>;
          cacheEntryRemoved: Promise<unknown>;
          updateCachedData: (fn: (draft: SessionUiStreamState) => void) => void;
          extra: unknown;
        }
      ) {
        const client = clientOf({ extra });
        let dispose: (() => void) | undefined;
        // Per-stream position index, kept in sync inside applyUiEvent for O(1) upserts.
        const itemIndex = buildIndex([]);
        try {
          await cacheDataLoaded;
          dispose = client.streamUiEvents(
            sessionId,
            (event) => {
              updateCachedData((draft) => applyUiEvent(draft, event, itemIndex));
            },
            {
              onError: (err) =>
                updateCachedData((draft) => {
                  draft.streamError = { kind: err.kind, status: err.status };
                })
            }
          );
        } catch {
          // cacheDataLoaded rejects when the entry is removed before it loads
        }
        await cacheEntryRemoved;
        dispose?.();
      }
    })
  })
});

export const { useStreamUiItemsQuery } = streamUiItemsApi;
