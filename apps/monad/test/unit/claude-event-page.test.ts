import { expect, mock, test } from 'bun:test';
import { claudeCodeMeshAgentAdapter, createClaudeSdkEventPageReader } from '@monad/atoms/agent-adapters';

const getSessionMessages = mock(async () => [
  {
    type: 'assistant',
    uuid: 'msg_100000000000',
    session_id: 'claude-session-1',
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'checking' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/project/a.ts' } }
      ]
    }
  },
  {
    type: 'user',
    uuid: 'msg_200000000000',
    session_id: 'claude-session-1',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body' }]
    }
  }
]);

test('Claude Code adapter reads paged history through the Agent SDK', async () => {
  const readEventPage = createClaudeSdkEventPageReader({
    getSessionMessages
  } as unknown as Parameters<typeof createClaudeSdkEventPageReader>[0]);
  const page = await readEventPage({
    providerSessionRef: 'claude-session-1',
    workingPath: '/tmp/project',
    limitBytes: 8192,
    request: { limit: 2, before: '2', sortDirection: 'desc', itemsView: 'full' }
  });

  expect(getSessionMessages).toHaveBeenCalledWith('claude-session-1', {
    dir: '/tmp/project',
    limit: 2,
    offset: 2,
    includeSystemMessages: true
  });
  expect(page?.nextCursor).toBe('4');

  const output = page?.items.map((item) => JSON.stringify(item)).join('\n') ?? '';

  const events = claudeCodeMeshAgentAdapter.parseOutput(output ?? '');
  expect(events).toEqual([
    { type: 'agent_message', payload: { text: 'checking' } },
    {
      type: 'tool_call',
      payload: {
        callId: 'toolu_1',
        tool: 'Read',
        input: { file_path: '/tmp/project/a.ts' }
      }
    },
    {
      type: 'tool_result',
      payload: {
        callId: 'toolu_1',
        output: 'file body'
      }
    }
  ]);
});
