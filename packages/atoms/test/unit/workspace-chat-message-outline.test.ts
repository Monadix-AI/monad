import type { Message } from '../../src/workplace-experiences/experience/types';

import { expect, test } from 'bun:test';

import {
  completeWorkspaceMessageOutlineItems,
  workspaceMessageOutlineItems
} from '../../src/workplace-experiences/chat-room/components/message-list';

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

test('completeWorkspaceMessageOutlineItems keeps unloaded messages and appends rendered optimistic messages', () => {
  const renderedItems = workspaceMessageOutlineItems(
    [message('u2', 'human', 'Loaded question'), message('optimistic', 'human', 'Pending question')],
    'Time unavailable'
  );

  expect(
    completeWorkspaceMessageOutlineItems(
      [
        { id: 'u1', text: '  Unloaded\n question  ' },
        { id: 'u2', text: 'Loaded question' }
      ],
      renderedItems,
      'Time unavailable'
    )
  ).toEqual([
    {
      id: 'u1',
      index: 0,
      label: 'Unloaded question',
      preview: '  Unloaded\n question  ',
      time: 'Time unavailable'
    },
    {
      id: 'u2',
      index: 1,
      label: 'Loaded question',
      preview: 'Loaded question',
      time: 'Time unavailable'
    },
    {
      id: 'optimistic',
      index: 2,
      label: 'Pending question',
      preview: 'Pending question',
      time: 'Time unavailable'
    }
  ]);
});
