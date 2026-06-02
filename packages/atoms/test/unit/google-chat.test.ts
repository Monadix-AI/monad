import { expect, test } from 'bun:test';

import { normalizeGChatEvent } from '../../src/channels/google-chat.ts';

test('GC1: MESSAGE event → inbound keyed by space; DM space → dm', () => {
  const ev = normalizeGChatEvent({
    type: 'MESSAGE',
    message: { text: 'hi', name: 'spaces/A/messages/1', sender: { name: 'users/u1', displayName: 'Al' } },
    space: { name: 'spaces/A', type: 'DM' },
    user: { name: 'users/u1' }
  });
  expect(ev).toMatchObject({ chatId: 'spaces/A', userId: 'users/u1', text: 'hi', chatType: 'dm', senderDisplay: 'Al' });
});

test('GC2: ROOM space → group; non-MESSAGE → null', () => {
  expect(
    normalizeGChatEvent({ type: 'MESSAGE', message: { text: 'x' }, space: { name: 'spaces/B', type: 'ROOM' } })
      ?.chatType
  ).toBe('group');
});
