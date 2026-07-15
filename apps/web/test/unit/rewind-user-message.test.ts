import { expect, test } from 'bun:test';

import { rewindUserMessage } from '../../src/features/session/rewind-user-message.ts';

test('successful rewind preserves the raw composer input used to render chips', async () => {
  const text = '/help with /global:deploy';
  const restored = await rewindUserMessage({
    messageId: 'msg_user00000000',
    restore: async () => {},
    sessionId: 'ses_test00000000',
    text
  });

  expect(restored).toBe(text);
});

test('failed rewind does not return composer input', async () => {
  const restored = await rewindUserMessage({
    messageId: 'msg_user00000000',
    restore: async () => {
      throw new Error('restore failed');
    },
    sessionId: 'ses_test00000000',
    text: '/global:deploy'
  });

  expect(restored).toBeNull();
});
