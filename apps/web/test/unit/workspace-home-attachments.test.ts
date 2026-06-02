import type { DraftChatSession } from '../../src/lib/workspace-shell-store.ts';

import { expect, test } from 'bun:test';

import {
  createAndSendWorkspaceDraft,
  workspaceDraftCanLaunch,
  workspaceInitialMessageRequest
} from '../../src/features/workspace/workspace-home-model.ts';

const attachment = {
  kind: 'file-meta' as const,
  mediaType: 'application/zip',
  name: 'bundle.zip',
  size: 2048
};

test('new chat launch accepts text or attachments and rejects an empty draft', () => {
  expect({
    attachmentOnly: workspaceDraftCanLaunch('', [attachment]),
    empty: workspaceDraftCanLaunch('   ', []),
    text: workspaceDraftCanLaunch('hello', [])
  }).toEqual({ attachmentOnly: true, empty: false, text: true });
});

test('draft retry reuses the exact attachment payload and send idempotency key', () => {
  const draft: DraftChatSession = {
    attachments: [attachment],
    id: 'ses_draft00000001',
    title: 'New chat',
    text: '',
    status: 'failed',
    createIdempotencyKey: 'idem_create',
    sendIdempotencyKey: 'idem_send',
    createdAt: '2026-07-28T09:00:00.000Z',
    updatedAt: '2026-07-28T09:00:00.000Z'
  };

  expect(workspaceInitialMessageRequest(draft, 'ses_real00000001')).toEqual({
    attachments: [attachment],
    idempotencyKey: 'idem_send',
    sessionId: 'ses_real00000001',
    text: ''
  });
});

test('new chat waits for the first message send before completing session creation', async () => {
  const operations: string[] = [];
  const draft: DraftChatSession = {
    attachments: [attachment],
    id: 'ses_draft00000001',
    title: 'New chat',
    text: 'Inspect this',
    status: 'creating',
    createIdempotencyKey: 'idem_create',
    sendIdempotencyKey: 'idem_send',
    createdAt: '2026-07-28T09:00:00.000Z',
    updatedAt: '2026-07-28T09:00:00.000Z'
  };

  const sessionId = await createAndSendWorkspaceDraft(draft, {
    createSession: () => ({
      unwrap: async () => {
        operations.push('create');
        return 'ses_real00000001';
      }
    }),
    onSessionCreated: (createdSessionId) => {
      operations.push(`created:${createdSessionId}`);
    },
    sendMessage: (request) => ({
      unwrap: async () => {
        operations.push(`send:${request.sessionId}`);
        return { accepted: true as const };
      }
    })
  });

  expect({ operations, sessionId }).toEqual({
    operations: ['create', 'created:ses_real00000001', 'send:ses_real00000001'],
    sessionId: 'ses_real00000001'
  });
});

test('new chat propagates a first-message failure instead of completing with an empty session', async () => {
  const draft: DraftChatSession = {
    attachments: [attachment],
    id: 'ses_draft00000001',
    title: 'New chat',
    text: 'Inspect this',
    status: 'creating',
    createIdempotencyKey: 'idem_create',
    sendIdempotencyKey: 'idem_send',
    createdAt: '2026-07-28T09:00:00.000Z',
    updatedAt: '2026-07-28T09:00:00.000Z'
  };

  expect(
    createAndSendWorkspaceDraft(draft, {
      createSession: () => ({ unwrap: async () => 'ses_real00000001' }),
      sendMessage: () => ({
        unwrap: async () => {
          throw new Error('attachment request rejected');
        }
      })
    })
  ).rejects.toThrow('attachment request rejected');
});
