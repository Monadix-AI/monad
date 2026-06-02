import type { ReactElement } from 'react';
import type { Message } from '../../src/workplace-experiences/experience/types.ts';

import { expect, test } from 'bun:test';

import { ReplyPreview } from '../../src/workplace-experiences/chat-room/components/reply-preview.tsx';

test('message reply previews open the target from a muted inline quote', () => {
  const target: Message = {
    id: 'msg_REPLY_TARGET0000',
    authorId: 'human',
    authorName: 'zeke',
    av: 'ZE',
    kind: 'human',
    tag: 'User',
    time: '',
    text: 'Review the latest implementation before merging.'
  };
  let openCount = 0;
  const preview = ReplyPreview({
    onOpen: () => {
      openCount += 1;
    },
    target,
    unavailableLabel: 'Message unavailable'
  }) as ReactElement<{ onClick: () => void }>;

  preview.props.onClick();

  expect(openCount).toBe(1);
});
