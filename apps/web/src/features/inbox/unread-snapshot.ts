import type { InboxItem } from '@monad/protocol';

export function createUnreadSnapshot(items: InboxItem[]): InboxItem[] {
  return items.map((item) => ({ ...item }));
}

export function markUnreadSnapshotRead(snapshot: InboxItem[], itemKeys: string[], readAt: string): InboxItem[] {
  const keys = new Set(itemKeys);
  return snapshot.map((item) => (keys.has(item.itemKey) ? { ...item, readAt } : item));
}

export function markUnreadSnapshotUnread(snapshot: InboxItem[], itemKeys: string[]): InboxItem[] {
  const keys = new Set(itemKeys);
  return snapshot.map((item) => {
    if (!keys.has(item.itemKey)) return item;
    const { readAt: _readAt, ...unread } = item;
    return unread;
  });
}

export function reconcileUnreadSnapshot(snapshot: InboxItem[], currentItems: InboxItem[]): InboxItem[] {
  const current = new Map(currentItems.map((item) => [item.itemKey, item]));
  return snapshot.map((item) => current.get(item.itemKey) ?? item);
}
