import type { Message } from '../../src/workspace-experiences/experience/types';

import { expect, test } from 'bun:test';

import { workspaceMessageOutlineItems } from '../../src/workspace-experiences/chat-room/components/message-list';

function message(id: string, kind: Message['kind'], text: string): Message {
  return {
    authorId: `${id}-author`,
    authorName: 'Author',
    av: 'AU',
    id,
    kind,
    tag: '@author',
    text,
    time: ''
  };
}

test('workspaceMessageOutlineItems indexes only human messages against the full transcript', () => {
  expect(
    workspaceMessageOutlineItems(
      [message('u1', 'human', '  First\n  question  '), message('a1', 'agent', 'Answer'), message('u2', 'human', '')],
      'Time unavailable'
    )
  ).toEqual([
    {
      id: 'u1',
      index: 0,
      label: 'First question',
      preview: '  First\n  question  ',
      time: 'Time unavailable'
    },
    {
      id: 'u2',
      index: 2,
      label: 'Message 3',
      preview: '',
      time: 'Time unavailable'
    }
  ]);
});
