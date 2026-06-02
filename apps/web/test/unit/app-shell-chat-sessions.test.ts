import type { Session } from '@monad/protocol';
import type { DraftChatSession } from '../../src/lib/workspace-shell-store.ts';

import { expect, test } from 'bun:test';

import { mergeWorkspaceChatSessions } from '../../src/features/shell/useAppShellData.ts';

test('a pending draft replaces its created server session in the sidebar', () => {
  const createdAt = '2026-07-28T12:24:26.648Z';
  const serverSession = {
    id: 'ses_real00000001',
    title: 'Create a video',
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    createdAt,
    updatedAt: createdAt
  } as Session;
  const draftSession: DraftChatSession = {
    attachments: [],
    createdAt,
    createIdempotencyKey: 'idem_create',
    id: 'ses_draft00000001',
    sendIdempotencyKey: 'idem_send',
    serverSessionId: serverSession.id,
    status: 'failed',
    text: 'Create a video',
    title: 'Create a video',
    updatedAt: createdAt
  };

  expect(mergeWorkspaceChatSessions([serverSession], [draftSession]).map((session) => session.id)).toEqual([
    'ses_draft00000001'
  ]);
});
