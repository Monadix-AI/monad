import { expect, test } from 'bun:test';

import { createClaudeSdkHistoryPageReader } from '../../src/agent-adapters/claude-code/index.ts';

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
