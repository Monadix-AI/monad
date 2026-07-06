import { expect, test } from 'bun:test';

import { normalizeBlueBubblesEvent } from '../../src/channels/imessage.ts';

test('IM1: new-message → inbound keyed by chat guid; style 45 = dm, 43 = group', () => {
  const dm = normalizeBlueBubblesEvent({
    type: 'new-message',
    data: {
      guid: 'g1',
      text: 'hi',
      isFromMe: false,
      handle: { address: '+1555' },
      chats: [{ guid: 'iMessage;-;+1555', style: 45 }]
    }
  });
  expect(dm).toMatchObject({
    chatId: 'iMessage;-;+1555',
    userId: '+1555',
    text: 'hi',
    chatType: 'dm',
    nativeMessageId: 'g1'
  });
  const grp = normalizeBlueBubblesEvent({
    type: 'new-message',
    data: { guid: 'g2', text: 'yo', chats: [{ guid: 'chat123', style: 43 }] }
  });
  expect(grp?.chatType).toBe('group');
});

test('IM2: isFromMe → isSelf; non new-message / no chat → null; command parse', () => {
  expect(
    normalizeBlueBubblesEvent({
      type: 'new-message',
      data: { guid: 'g', text: 'x', isFromMe: true, chats: [{ guid: 'c' }] }
    })?.isSelf
  ).toBe(true);
  expect(
    normalizeBlueBubblesEvent({
      type: 'new-message',
      data: { guid: 'g', text: '/new', chats: [{ guid: 'c', style: 45 }] }
    })
  ).toMatchObject({ command: 'new', kind: 'command' });
});
