export interface ArchivedSessionListItem {
  id: string;
  projectId?: string | null;
  projectName?: string;
  title: string;
  updatedAt: string;
}

type ArchivedSessionBucketId = 'today' | 'yesterday' | 'earlier';

export interface ArchivedSessionBucket {
  id: ArchivedSessionBucketId;
  items: ArchivedSessionListItem[];
  label: string;
}

export function archivedSessionBuckets(
  items: ArchivedSessionListItem[],
  now: Date = new Date(),
  locale = 'en',
  earlierLabel = 'Earlier'
): ArchivedSessionBucket[] {
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const buckets: ArchivedSessionBucket[] = [
    { id: 'today', items: [], label: relative.format(0, 'day') },
    { id: 'yesterday', items: [], label: relative.format(-1, 'day') },
    { id: 'earlier', items: [], label: earlierLabel }
  ];
  const todayKey = localDateKey(now);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const yesterdayKey = localDateKey(yesterday);

  for (const item of [...items].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))) {
    const itemKey = localDateKey(new Date(item.updatedAt));
    const bucketId: ArchivedSessionBucketId =
      itemKey === todayKey ? 'today' : itemKey === yesterdayKey ? 'yesterday' : 'earlier';
    buckets.find((bucket) => bucket.id === bucketId)?.items.push(item);
  }

  return buckets.filter((bucket) => bucket.items.length > 0);
}

export function visibleArchivedBucketItems(
  bucket: ArchivedSessionBucket,
  earlierVisibleCount: number
): ArchivedSessionListItem[] {
  return bucket.id === 'earlier' ? bucket.items.slice(0, earlierVisibleCount) : bucket.items;
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
