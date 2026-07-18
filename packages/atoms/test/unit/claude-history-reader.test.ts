import { expect, test } from 'bun:test';

import {
  createClaudeSdkHistoryOutputReader,
  createClaudeSdkHistoryPageReader
} from '../../src/agent-adapters/claude-code/index.ts';

test('Claude SDK history keeps the native session start when the transcript exceeds the snapshot limit', async () => {
  const calls: unknown[] = [];
  const reader = createClaudeSdkHistoryOutputReader({
    getSessionMessages: (async (...args: unknown[]) => {
      calls.push(args);
      return [
        {
          type: 'user',
          uuid: 'message-start',
          session_id: 'claude-session',
          message: { role: 'user', content: 'native session start' },
          parent_tool_use_id: null
        },
        {
          type: 'assistant',
          uuid: 'message-latest',
          session_id: 'claude-session',
          message: { role: 'assistant', content: [{ type: 'text', text: 'latest reply' }] },
          parent_tool_use_id: null
        }
      ];
    }) as never
  });

  expect(
    await reader({
      providerSessionRef: 'claude-session',
      workingPath: '/tmp/project',
      limitBytes: 1
    })
  ).toEqual(
    [
      {
        type: 'user',
        uuid: 'message-start',
        session_id: 'claude-session',
        message: { role: 'user', content: 'native session start' },
        parent_tool_use_id: null
      },
      {
        type: 'assistant',
        uuid: 'message-latest',
        session_id: 'claude-session',
        message: { role: 'assistant', content: [{ type: 'text', text: 'latest reply' }] },
        parent_tool_use_id: null
      }
    ]
      .map((message) => JSON.stringify(message))
      .join('\n')
  );
  expect(calls).toEqual([
    [
      'claude-session',
      {
        dir: '/tmp/project',
        includeSystemMessages: true
      }
    ]
  ]);
});

test('Claude SDK history contains only provider-returned messages', async () => {
  const reader = createClaudeSdkHistoryPageReader({
    getSessionMessages: (async () => [
      {
        type: 'assistant',
        uuid: 'message-1',
        session_id: 'claude-session',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        parent_tool_use_id: null
      }
    ]) as never
  });

  expect(
    await reader({
      providerSessionRef: 'claude-session',
      workingPath: '/tmp/project',
      limitBytes: 1024,
      request: { limit: 20, sortDirection: 'desc', itemsView: 'full' }
    })
  ).toEqual({
    items: [
      {
        type: 'assistant',
        uuid: 'message-1',
        session_id: 'claude-session',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        parent_tool_use_id: null
      }
    ]
  });
});
