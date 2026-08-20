import { expect, test } from 'bun:test';

import { createNativeAgentDirectApi } from '#/services/native-agent/direct.ts';
import { createStore } from '#/store/db/index.ts';

test('direct send replays durable request identity after capability recreation and rejects changed intent', async () => {
  const store = createStore();
  const notifications: string[] = [];
  const handlers = {
    _nativeAgentStore: store,
    session: {
      resolveManagedMeshAgentDirectTarget: ({ target }: { target: string }) => ({
        kind: 'project_member' as const,
        projectMemberId: target
      }),
      notifyManagedMeshAgentDirectMessage: async ({ message }: { message: { id: string } }) => {
        notifications.push(message.id);
      }
    }
  };
  let attachmentSequence = 0;
  const resolveAttachmentPayload = async (body: { text?: string }) => {
    attachmentSequence += 1;
    const id = `att_DIRECT00000${attachmentSequence}` as const;
    const attachment = store.registerMessageAttachment({
      id,
      sessionId: 'ses_project00000',
      path: '/tmp/report.md',
      name: 'report.md',
      mime: 'text/markdown',
      bytes: 10,
      preview: 'report',
      createdBy: 'codex',
      createdAt: `2026-07-24T00:00:0${attachmentSequence}.000Z`
    });
    return {
      text: body.text ?? '',
      noticeText: body.text ?? '',
      attachments: [attachment]
    };
  };
  const binding = {
    projectMemberId: 'pmem_codex',
    sessionId: 'ses_project00000' as const,
    meshSessionId: 'mesh_direct000000'
  };

  try {
    const first = await createNativeAgentDirectApi(handlers as never, resolveAttachmentPayload as never).send({
      body: {
        requestId: 'direct-request-1',
        to: 'claude',
        text: 'private handoff',
        attachments: [{ path: '/tmp/report.md' }]
      },
      binding,
      attachmentRoots: []
    });
    const replay = await createNativeAgentDirectApi(handlers as never, resolveAttachmentPayload as never).send({
      body: {
        requestId: 'direct-request-1',
        to: 'claude',
        text: 'private handoff',
        attachments: [{ path: '/tmp/report.md' }]
      },
      binding,
      attachmentRoots: []
    });

    expect({ first: first.message, replay: replay.message, notifications }).toEqual({
      first: first.message,
      replay: first.message,
      notifications: [first.message.id]
    });
    expect({
      originalAttachment: store.getMessageAttachment('att_DIRECT000001')?.id,
      replayAttachment: store.getMessageAttachment('att_DIRECT000002')
    }).toEqual({
      originalAttachment: 'att_DIRECT000001',
      replayAttachment: null
    });
    await expect(
      createNativeAgentDirectApi(handlers as never, resolveAttachmentPayload as never).send({
        body: {
          requestId: 'direct-request-1',
          to: 'claude',
          text: 'changed handoff',
          attachments: [{ path: '/tmp/report.md' }]
        },
        binding,
        attachmentRoots: []
      })
    ).rejects.toMatchObject({
      kind: 'conflict',
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'idempotency key reused with a different command'
    });
  } finally {
    store.close();
  }
});
