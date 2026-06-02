import type { InboxItem } from '@monad/protocol';

import { expect, test } from 'bun:test';

import * as unreadSnapshot from '#/features/inbox/unread-snapshot';

const mention: InboxItem = {
  itemKey: 'mention:msg_ABCDEF123456',
  sessionId: 'ses_ABCDEF123456',
  createdAt: '2026-07-22T00:00:01.000Z',
  actionState: 'informational',
  kind: 'mention',
  id: 'msg_ABCDEF123456',
  message: {
    id: 'msg_ABCDEF123456',
    sessionId: 'ses_ABCDEF123456',
    role: 'assistant',
    text: '@[name="zeke" id="human"] review this',
    type: 'text',
    stream: { status: 'settled' },
    active: true,
    createdAt: '2026-07-22T00:00:01.000Z'
  }
};

const approval: InboxItem = {
  itemKey: 'approval:req_ABCDEF123456',
  sessionId: 'ses_ABCDEF123456',
  createdAt: '2026-07-22T00:00:02.000Z',
  actionState: 'needs-response',
  kind: 'approval',
  id: 'req_ABCDEF123456',
  approvalKind: 'tool',
  tool: 'shell_exec'
};

test('Unread snapshot read-state updates keep the same ordered members', () => {
  const functions = unreadSnapshot as unknown as {
    createUnreadSnapshot?: (items: InboxItem[]) => InboxItem[];
    markUnreadSnapshotRead?: (snapshot: InboxItem[], itemKeys: string[], readAt: string) => InboxItem[];
    markUnreadSnapshotUnread?: (snapshot: InboxItem[], itemKeys: string[]) => InboxItem[];
  };
  const snapshot = functions.createUnreadSnapshot?.([mention, approval]);
  const readAt = '2026-07-22T00:01:00.000Z';

  const read = snapshot ? functions.markUnreadSnapshotRead?.(snapshot, [mention.itemKey], readAt) : undefined;
  expect(read).toEqual([{ ...mention, readAt }, approval]);
  expect(read ? functions.markUnreadSnapshotUnread?.(read, [mention.itemKey]) : undefined).toEqual([mention, approval]);
});

test('Unread snapshot reconciles matching data without removing or inserting members', () => {
  const functions = unreadSnapshot as unknown as {
    createUnreadSnapshot?: (items: InboxItem[]) => InboxItem[];
    reconcileUnreadSnapshot?: (snapshot: InboxItem[], current: InboxItem[]) => InboxItem[];
  };
  const snapshot = functions.createUnreadSnapshot?.([mention, approval]);
  const completedApproval: InboxItem = {
    ...approval,
    actionState: 'completed',
    resolvedAt: '2026-07-22T00:02:00.000Z'
  };
  const newlyArrived: InboxItem = {
    ...mention,
    itemKey: 'mention:msg_ABCDEF123457',
    id: 'msg_ABCDEF123457',
    message: { ...mention.message, id: 'msg_ABCDEF123457' }
  };

  expect(
    snapshot ? functions.reconcileUnreadSnapshot?.(snapshot, [completedApproval, newlyArrived]) : undefined
  ).toEqual([mention, completedApproval]);
});
