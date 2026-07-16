import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

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

test('archived time bucket labels are smaller and non-interactive', () => {
  const source = readFileSync(new URL('../../src/features/shell/sidebar/archived-items.tsx', import.meta.url), 'utf8');

  expect(source).toContain('className="px-2 pb-1 text-[10px] text-muted-foreground leading-4"');
  expect(source).not.toContain('<SidebarNavSectionLabel>{bucket.label}</SidebarNavSectionLabel>');
});

test('archived session search uses the archived server scope instead of local filtering', () => {
  const source = readFileSync(new URL('../../src/features/shell/sidebar/archived-items.tsx', import.meta.url), 'utf8');

  expect(source).toContain('useServerSessionSearch({');
  expect(source).toContain('archived: true');
  expect(source).toContain('limit: 200');
  expect(source).not.toContain('filterArchivedSessions');
});

test('archived session rows expose the shared undoable delete action', () => {
  const itemSource = readFileSync(
    new URL('../../src/features/shell/sidebar/archived-items.tsx', import.meta.url),
    'utf8'
  );
  const actionsSource = readFileSync(
    new URL('../../src/features/shell/session-sidebar-actions.ts', import.meta.url),
    'utf8'
  );

  expect(itemSource).toContain('icon: Delete02Icon');
  expect(itemSource).toContain("label: t('web.sidebar.deleteSession')");
  expect(itemSource).toContain('onDeleteSession(sessionId, item.title)');
  expect(actionsSource).toContain('deleteArchivedSession');
  expect(actionsSource).toContain('queueSessionDelete({');
  expect(actionsSource).toMatch(
    /const deleteArchivedSession = useCallback\([\s\S]*?queueSessionDelete\(\{\s*sessionId,\s*title\s*\}\);/
  );
});

test('archived search keeps the current list visible without a loading indicator', () => {
  const source = readFileSync(new URL('../../src/features/shell/sidebar/archived-items.tsx', import.meta.url), 'utf8');

  expect(source).toMatch(
    /searchingServer && !searching\s*\?\s*searchItems\s*:\s*\[\.\.\.projectSessions, \.\.\.chatSessions\]/s
  );
  expect(source).not.toContain('searchingServer && searching');
});
