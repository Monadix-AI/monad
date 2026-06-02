import type { MessageId, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { rewindUserMessage } from '../../src/features/session/rewind-user-message.ts';

const messageId = 'msg_rewind000000' as MessageId;
const sessionId = 'ses_rewind000000' as SessionId;

test('rewind restores the target before sending its edited replacement', async () => {
  const calls: string[] = [];

  const succeeded = await rewindUserMessage({
    messageId,
    restore: async (request) => {
      calls.push(`restore:${request.toMessageId}`);
    },
    send: async (text) => {
      calls.push(`send:${text}`);
    },
    sessionId,
    text: 'Edited prompt'
  });

  expect({ calls, succeeded }).toEqual({
    calls: [`restore:${messageId}`, 'send:Edited prompt'],
    succeeded: true
  });
});

test('rewind does not send when restoring the target fails', async () => {
  const calls: string[] = [];

  const succeeded = await rewindUserMessage({
    messageId,
    restore: async () => {
      calls.push('restore');
      throw new Error('restore failed');
    },
    send: async () => {
      calls.push('send');
    },
    sessionId,
    text: 'Edited prompt'
  });

  expect({ calls, succeeded }).toEqual({ calls: ['restore'], succeeded: false });
});
