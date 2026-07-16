import { expect, test } from 'bun:test';

import { archivedSessionBuckets, visibleArchivedBucketItems } from '../../src/features/shell/archived-sessions.ts';

const now = new Date('2026-07-15T12:00:00+08:00');

test('archived sessions group into today yesterday and earlier', () => {
  const buckets = archivedSessionBuckets(
    [
      { id: 'today', title: 'Today', updatedAt: '2026-07-15T03:00:00.000Z' },
      { id: 'yesterday', title: 'Yesterday', updatedAt: '2026-07-14T03:00:00.000Z' },
      { id: 'earlier', title: 'Earlier', updatedAt: '2026-07-10T03:00:00.000Z' }
    ],
    now
  );

  expect(buckets.map((bucket) => bucket.id)).toEqual(['today', 'yesterday', 'earlier']);
  expect(buckets.map((bucket) => bucket.items.map((item) => item.id))).toEqual([['today'], ['yesterday'], ['earlier']]);
});

test('only the earlier bucket is capped by more count', () => {
  const earlier = {
    id: 'earlier' as const,
    items: Array.from({ length: 6 }, (_, index) => ({
      id: `older-${index}`,
      title: `Older ${index}`,
      updatedAt: '2026-07-01T03:00:00.000Z'
    })),
    label: 'Earlier'
  };

  expect(visibleArchivedBucketItems(earlier, 4).map((item) => item.id)).toEqual([
    'older-0',
    'older-1',
    'older-2',
    'older-3'
  ]);
});
