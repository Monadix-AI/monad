import type { Message } from '../../src/workspace-experiences/experience/types.ts';

import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { MessageRow } from '../../src/workspace-experiences/chat-room/components/message-row.tsx';

test('human message keeps initials behind its profile image so avatar failures have a visible fallback', () => {
  const message: Message = {
    id: 'msg_user_avatar',
    authorId: 'me',
    authorName: 'Zeke',
    av: 'ZE',
    avatarUrl: '/api/avatar-cache/user.svg',
    kind: 'human',
    tag: 'User',
    time: '10:30',
    text: 'Hello'
  };

  const markup = renderToStaticMarkup(<MessageRow msg={message} />);

  expect(markup).toContain('>ZE<');
  expect(markup).toContain('<img');
  expect(markup).toContain('src="/api/avatar-cache/user.svg"');
});
