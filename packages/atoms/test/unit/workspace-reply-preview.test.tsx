import type { ReactElement } from 'react';
import type { Message } from '../../src/workplace-experiences/experience/types.ts';

import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

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
    text: 'Review with @[name="Ada" id="agent_ada"] before merging.'
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
  const markup = renderToStaticMarkup(preview);

  expect({
    mentionChip: markup.includes('data-composer-chip="mention"'),
    openCount,
    quoteMarker: markup.includes('data-reply-quote-marker=""')
  }).toEqual({
    mentionChip: true,
    openCount: 1,
    quoteMarker: true
  });
});
