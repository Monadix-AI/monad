import type { SessionId, SessionUiEvent, UIItem, UIMessageItem, UIMessageOutlineItem } from '@monad/protocol';

import { clientOf } from '../../endpoint-helpers.ts';
import { sendMessageApi } from './send-message.ts';

export const MAX_CANONICAL_MESSAGE_CHANGES = 256;

export type CanonicalMessageChange =
  | { kind: 'reset'; revision: number }
  | { item: UIMessageItem; kind: 'upsert'; revision: number }
  | { kind: 'remove'; messageId: string; revision: number };

export interface SessionUiStreamState {
  items: UIItem[];
  messageOutline: UIMessageOutlineItem[];
  /** True after the daemon's first authoritative snapshot, including an empty transcript. */
  snapshotReceived: boolean;
  /** Oldest message id in the (bounded) live window — the `before` cursor for loading older history. */
  oldestCursor?: string;
  /** True when older messages exist before the live window (so the client can page history). */
  hasMore?: boolean;
  /** Advances when the daemon replaces the authoritative transcript after a restore or reset. */
  replacementRevision?: number;
  /** Latest-per-message canonical mutations retained for detached-window and lookup reconciliation. */
  canonicalMessageChanges: CanonicalMessageChange[];
  /** Highest revision evicted before a consumer could necessarily observe it. */
  canonicalMessageDroppedRevision: number;
  canonicalMessageRevision: number;
  canonicalSnapshotCursor?: string;
  streamError?: { kind: 'fatal' | 'transient'; status?: number };
}

function keyOf(item: UIItem): string {
  return `${item.kind}:${item.id}`;
}

function outlineText(item: UIMessageItem): string {
  return (
    item.parts?.find((part) => part.type === 'text')?.text ??
    item.parts?.find((part) => part.type === 'artifact')?.text ??
    ''
  );
}

function reconcileMessageOutline(draft: SessionUiStreamState, item: UIMessageItem): void {
  const existing = draft.messageOutline.findIndex((entry) => entry.id === item.id);
  if (item.role !== 'user') {
    if (existing >= 0) draft.messageOutline.splice(existing, 1);
    return;
  }
  // `seq` IS the message's ISO creation time, so a live upsert can supply the same `at` the
  // snapshot carries — without it every message sent during a session reads "time unavailable"
  // in the outline until the next reconnect, and an upsert would erase an entry's existing time.
  const next = { id: item.id, text: outlineText(item), ...(item.seq ? { at: item.seq } : {}) };
  if (existing >= 0) draft.messageOutline[existing] = next;
  else draft.messageOutline.push(next);
}

/** `kind:id → array position`, kept in sync with `items` so per-token upserts are O(1) instead of a
 *  linear `findIndex` scan over the whole transcript (which, run once per streamed token, is O(n²)). */
export function buildIndex(items: UIItem[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < items.length; i++) index.set(keyOf(items[i] as UIItem), i);
  return index;
}

function recordCanonicalMessageReset(draft: SessionUiStreamState, canonicalIndex?: Map<string, number>): void {
  const revision = draft.canonicalMessageRevision + 1;
  draft.canonicalMessageRevision = revision;
  draft.canonicalMessageChanges = [{ kind: 'reset', revision }];
  canonicalIndex?.clear();
}

function snapshotRestartsCanonicalState(
  draft: SessionUiStreamState,
  event: Extract<SessionUiEvent, { kind: 'snapshot' }>
): boolean {
  if (!draft.snapshotReceived || event.replacesTranscript) return true;
  if (event.cursor !== undefined || draft.canonicalSnapshotCursor !== undefined) {
    return event.cursor !== draft.canonicalSnapshotCursor;
  }
  return JSON.stringify(draft.items) !== JSON.stringify(event.items);
}

function recordCanonicalMessageChange(
  draft: SessionUiStreamState,
  change:
    | Omit<Extract<CanonicalMessageChange, { kind: 'upsert' }>, 'revision'>
    | Omit<Extract<CanonicalMessageChange, { kind: 'remove' }>, 'revision'>,
  canonicalIndex?: Map<string, number>
): void {
  const messageId = change.kind === 'upsert' ? change.item.id : change.messageId;
  const revision = draft.canonicalMessageRevision + 1;
  draft.canonicalMessageRevision = revision;
  const next = { ...change, revision } as CanonicalMessageChange;
  const existing =
    canonicalIndex?.get(messageId) ??
    draft.canonicalMessageChanges.findIndex((entry) => {
      if (entry.kind === 'reset') return false;
      return entry.kind === 'upsert' ? entry.item.id === messageId : entry.messageId === messageId;
    });
  if (existing !== undefined && existing >= 0) {
    draft.canonicalMessageChanges[existing] = next;
    canonicalIndex?.set(messageId, existing);
    return;
  }
  if (draft.canonicalMessageChanges.length < MAX_CANONICAL_MESSAGE_CHANGES) {
    const at = draft.canonicalMessageChanges.push(next) - 1;
    canonicalIndex?.set(messageId, at);
    return;
  }
  let oldestAt = 0;
  for (let i = 1; i < draft.canonicalMessageChanges.length; i++) {
    if (
      (draft.canonicalMessageChanges[i]?.revision ?? Number.MAX_SAFE_INTEGER) <
      (draft.canonicalMessageChanges[oldestAt]?.revision ?? 0)
    ) {
      oldestAt = i;
    }
  }
  const evicted = draft.canonicalMessageChanges[oldestAt];
  if (evicted) {
    draft.canonicalMessageDroppedRevision = Math.max(draft.canonicalMessageDroppedRevision, evicted.revision);
    if (evicted.kind !== 'reset') {
      canonicalIndex?.delete(evicted.kind === 'upsert' ? evicted.item.id : evicted.messageId);
    }
  }
  draft.canonicalMessageChanges[oldestAt] = next;
  canonicalIndex?.set(messageId, oldestAt);
}

export function applyUiEvent(
  draft: SessionUiStreamState,
  event: SessionUiEvent,
  index: Map<string, number>,
  canonicalIndex?: Map<string, number>
): void {
  if (draft.streamError) draft.streamError = undefined;
  if (event.kind === 'snapshot') {
    const restartCanonicalState = snapshotRestartsCanonicalState(draft, event);
    draft.items = event.items;
    draft.messageOutline =
      event.messageOutline ??
      event.items.flatMap((item) =>
        item.kind === 'message' && item.role === 'user' ? [{ id: item.id, text: outlineText(item) }] : []
      );
    if (event.messageOutline) {
      for (const item of event.items) {
        if (item.kind === 'message') reconcileMessageOutline(draft, item);
      }
    }
    draft.snapshotReceived = true;
    draft.oldestCursor = event.oldestCursor;
    draft.hasMore = event.hasMore ?? false;
    draft.canonicalSnapshotCursor = event.cursor;
    if (event.replacesTranscript) {
      draft.replacementRevision = (draft.replacementRevision ?? 0) + 1;
    }
    index.clear();
    for (let i = 0; i < event.items.length; i++) index.set(keyOf(event.items[i] as UIItem), i);
    if (restartCanonicalState) recordCanonicalMessageReset(draft, canonicalIndex);
    return;
  }
  if (event.kind === 'upsert') {
    const key = keyOf(event.item);
    const at = index.get(key);
    if (at !== undefined) draft.items[at] = event.item;
    else index.set(key, draft.items.push(event.item) - 1);
    if (event.item.kind === 'message') {
      reconcileMessageOutline(draft, event.item);
      recordCanonicalMessageChange(draft, { item: event.item, kind: 'upsert' }, canonicalIndex);
    }
    return;
  }
  // Removal shifts positions; rebuild the index (rare relative to upserts).
  draft.items = draft.items.filter((item) => item.kind !== event.target.kind || item.id !== event.target.id);
  index.clear();
  for (let i = 0; i < draft.items.length; i++) index.set(keyOf(draft.items[i] as UIItem), i);
  if (event.target.kind === 'message') {
    draft.messageOutline = draft.messageOutline.filter((item) => item.id !== event.target.id);
    recordCanonicalMessageChange(draft, { kind: 'remove', messageId: event.target.id }, canonicalIndex);
  }
}

const streamUiItemsApi = sendMessageApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    streamUiItems: builder.query<SessionUiStreamState, SessionId>({
      keepUnusedDataFor: 0,
      queryFn: () => ({
        data: {
          canonicalMessageChanges: [],
          canonicalMessageDroppedRevision: 0,
          canonicalMessageRevision: 0,
          items: [],
          messageOutline: [],
          hasMore: false,
          replacementRevision: 0,
          snapshotReceived: false
        }
      }),
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
        const canonicalIndex = new Map<string, number>();
        try {
          await cacheDataLoaded;
          dispose = client.streamUiEvents(
            sessionId,
            (event) => {
              updateCachedData((draft) => applyUiEvent(draft, event, itemIndex, canonicalIndex));
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
