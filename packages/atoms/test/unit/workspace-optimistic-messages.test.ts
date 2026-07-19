import type { Message, Participant } from '../../src/workspace-experiences/experience/types.ts';

import { expect, test } from 'bun:test';

import { shouldJumpToOwnMessage } from '../../src/workspace-experiences/chat-room/components/message-list.tsx';
import {
  createOptimisticUserMessage,
  mergeOptimisticMessages,
  type OptimisticChatMessage
} from '../../src/workspace-experiences/chat-room/utils/optimistic-messages.ts';

test('optimistic user messages render immediately until the server echo arrives', () => {
  const human: Participant = {
    id: 'me',
    av: 'OP',
    avatarUrl: 'https://avatar.example/operator.png',
    name: 'Operator',
    kind: 'human',
    tag: 'User',
    presence: 'online'
  };
  const optimistic = createOptimisticUserMessage({
    human,
    id: 'optimistic-1',
    retry: () => {},
    status: 'sending',
    text: 'hello project'
  });

  expect(optimistic).toMatchObject({
    id: 'optimistic-1',
    authorName: 'Operator',
    av: 'OP',
    avatarUrl: 'https://avatar.example/operator.png',
    kind: 'human',
    localStatus: 'sending',
    tag: 'User',
    text: 'hello project'
  });

  expect(mergeOptimisticMessages([], [optimistic])).toEqual([optimistic]);

  const serverEcho = {
    ...optimistic,
    id: 'msg_server000000',
    localStatus: undefined,
    retrySend: undefined
  };

  expect(mergeOptimisticMessages([serverEcho], [optimistic])).toEqual([serverEcho]);
});

test('server echoes keep the optimistic render key to avoid remount flicker', () => {
  const optimistic = createOptimisticUserMessage({
    createdAt: '2026-07-06T12:00:00.000Z',
    human: {
      id: 'me',
      av: 'OP',
      name: 'Operator',
      kind: 'human',
      tag: 'User',
      presence: 'online'
    },
    id: 'optimistic-1',
    retry: () => {},
    status: 'sending',
    text: 'hello project'
  });
  const serverEcho = {
    ...optimistic,
    id: 'msg_server000000',
    localStatus: undefined,
    orderKey: '2026-07-06T12:00:01.000Z',
    retrySend: undefined
  };

  expect(mergeOptimisticMessages([serverEcho], [optimistic])).toEqual([{ ...serverEcho, renderKey: 'optimistic-1' }]);
});

test('server echoes consume optimistic render keys one-to-one', () => {
  const first = createOptimisticUserMessage({
    createdAt: '2026-07-06T12:00:00.000Z',
    human: {
      id: 'me',
      av: 'OP',
      name: 'Operator',
      kind: 'human',
      tag: 'User',
      presence: 'online'
    },
    id: 'optimistic-1',
    retry: () => {},
    status: 'sending',
    text: 'same text'
  });
  const second = createOptimisticUserMessage({
    createdAt: '2026-07-06T12:00:01.000Z',
    human: {
      id: 'me',
      av: 'OP',
      name: 'Operator',
      kind: 'human',
      tag: 'User',
      presence: 'online'
    },
    id: 'optimistic-2',
    retry: () => {},
    status: 'sending',
    text: 'same text'
  });
  const firstEcho = { ...first, id: 'msg_100000000000', localStatus: undefined, retrySend: undefined };
  const secondEcho = { ...second, id: 'msg_200000000000', localStatus: undefined, retrySend: undefined };

  expect(mergeOptimisticMessages([firstEcho, secondEcho], [first, second]).map((message) => message.renderKey)).toEqual(
    ['optimistic-1', 'optimistic-2']
  );
});

test('unmatched optimistic user messages keep chronological order before later Q&A replies', () => {
  const optimistic = createOptimisticUserMessage({
    createdAt: '2026-07-18T13:03:30.000Z',
    human: {
      id: 'me',
      av: 'OP',
      name: 'Operator',
      kind: 'human',
      tag: 'User',
      presence: 'online'
    },
    id: 'optimistic-1',
    retry: () => {},
    status: 'sent',
    text: 'Write the introduction'
  });
  const qAndA: Message = {
    id: 'msg_qanda0000000',
    authorId: 'agent',
    authorName: 'GPT',
    av: 'GP',
    kind: 'agent',
    tag: 'Codex',
    time: '',
    text: 'Q: Which structure?\nA: Progressive disclosure',
    orderKey: '2026-07-18T13:03:44.000Z'
  };

  expect(mergeOptimisticMessages([qAndA], [optimistic]).map((message) => message.id)).toEqual([
    'optimistic-1',
    'msg_qanda0000000'
  ]);
});

test('optimistic user messages use the current human identity', () => {
  const human: Participant = {
    id: 'me',
    av: 'ME',
    avatarUrl: 'https://avatar.example/me.png',
    name: 'Operator',
    kind: 'human',
    tag: 'User',
    presence: 'online'
  };

  expect(
    createOptimisticUserMessage({
      human,
      id: 'optimistic-1',
      retry: () => {},
      status: 'sending',
      text: 'hello project'
    })
  ).toMatchObject({
    authorId: 'me',
    authorName: 'Operator',
    av: 'ME',
    avatarUrl: 'https://avatar.example/me.png',
    renderKey: 'optimistic-1'
  });
});

test("sending a message jumps to the bottom once; status changes and others' messages do not", () => {
  expect({
    ownMessageAppears: shouldJumpToOwnMessage('optimistic-1', undefined, 'sending'),
    // 'sending' -> 'sent' on the same message must not drag a reader who scrolled up after sending.
    sameMessageResolves: shouldJumpToOwnMessage('optimistic-1', 'optimistic-1', 'sent'),
    ownMessageFails: shouldJumpToOwnMessage('optimistic-2', 'optimistic-1', 'failed'),
    incomingMessage: shouldJumpToOwnMessage('msg_from_agent', 'optimistic-1', undefined),
    emptyList: shouldJumpToOwnMessage(undefined, undefined, 'sending')
  }).toEqual({
    ownMessageAppears: true,
    sameMessageResolves: false,
    ownMessageFails: true,
    incomingMessage: false,
    emptyList: false
  });
});

test('failed optimistic user messages stay retryable when no server echo exists', () => {
  const retryCalls: string[] = [];
  const failed: OptimisticChatMessage = createOptimisticUserMessage({
    human: {
      id: 'me',
      av: 'OP',
      name: 'Operator',
      kind: 'human',
      tag: 'User',
      presence: 'online'
    },
    id: 'optimistic-failed',
    retry: () => retryCalls.push('retry'),
    status: 'failed',
    text: 'try again'
  });

  expect(mergeOptimisticMessages([], [failed])).toEqual([failed]);

  failed.retrySend?.();

  expect(retryCalls).toEqual(['retry']);
});
