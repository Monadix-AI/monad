import type { MessageIngress } from '#/services/messages/types.ts';

import { expect, test } from 'bun:test';

import { createTranscriptProjector } from '#/handlers/transcript/projector.ts';

test('transcript projector delegates streaming lifecycle exclusively to Message Ingress', async () => {
  const calls: Array<{ operation: string; command: unknown }> = [];
  const messageIngress = {
    begin: async (command: unknown) => {
      calls.push({ operation: 'begin', command });
      return { id: 'msg_projector0000' };
    },
    settle: async (command: unknown) => {
      calls.push({ operation: 'settle', command });
      return { id: 'msg_projector0000' };
    }
  } as unknown as MessageIngress;
  const projector = createTranscriptProjector({ messageIngress });

  const created = await projector.insertAssistantMessage({
    sessionId: 'ses_projector0000',
    agentName: 'Fable',
    text: 'Waiting',
    data: { kind: 'project-qa' },
    includeInContext: false,
    streamStatus: 'streaming'
  });
  await projector.completeAssistantMessage({
    sessionId: 'ses_projector0000',
    messageId: created.messageId,
    agentName: 'Fable',
    text: 'Answered'
  });

  expect(calls).toEqual([
    {
      operation: 'begin',
      command: {
        transcriptTargetId: 'ses_projector0000',
        idempotencyKey: expect.stringMatching(/^idem_/),
        producer: { kind: 'system', subsystem: 'transcript-projector' },
        role: 'assistant',
        type: 'text',
        text: 'Waiting',
        data: { agentName: 'Fable', kind: 'project-qa' },
        includeInContext: false
      }
    },
    {
      operation: 'settle',
      command: {
        transcriptTargetId: 'ses_projector0000',
        messageId: 'msg_projector0000',
        idempotencyKey: expect.stringMatching(/^idem_/),
        producer: { kind: 'system', subsystem: 'transcript-projector' },
        text: 'Answered'
      }
    }
  ]);
});
