import { expect, test } from 'bun:test';

import {
  createOptimisticUserMessage,
  mergeOptimisticMessages,
  type OptimisticChatMessage
} from '../../src/workspace-experiences/chat-room/utils/optimistic-messages.ts';

test('optimistic user messages render immediately until the server echo arrives', () => {
  const optimistic = createOptimisticUserMessage({
    id: 'optimistic-1',
    retry: () => {},
    status: 'sending',
    text: 'hello project'
  });

  expect(optimistic).toMatchObject({
    id: 'optimistic-1',
    authorName: 'You',
    kind: 'human',
    localStatus: 'sending',
    tag: 'User',
    text: 'hello project'
  });

  expect(mergeOptimisticMessages([], [optimistic])).toEqual([optimistic]);

  const serverEcho = {
    ...optimistic,
    id: 'msg_server',
    localStatus: undefined,
    retrySend: undefined
  };

  expect(mergeOptimisticMessages([serverEcho], [optimistic])).toEqual([serverEcho]);
});

test('failed optimistic user messages stay retryable when no server echo exists', () => {
  const retryCalls: string[] = [];
  const failed: OptimisticChatMessage = createOptimisticUserMessage({
    id: 'optimistic-failed',
    retry: () => retryCalls.push('retry'),
    status: 'failed',
    text: 'try again'
  });

  expect(mergeOptimisticMessages([], [failed])).toEqual([failed]);

  failed.retrySend?.();

  expect(retryCalls).toEqual(['retry']);
});
