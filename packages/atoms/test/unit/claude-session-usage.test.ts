import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';

import { expect, test } from 'bun:test';

import {
  claudeSessionUsage,
  createClaudeSessionUsageReader
} from '../../src/agent-adapters/claude-code/session-usage.ts';

function assistantMessage(
  id: string,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  },
  model = 'claude-opus-4-8'
): SessionMessage {
  return {
    type: 'assistant',
    uuid: `uuid-${id}`,
    session_id: 'claude-session',
    message: { id, model, usage },
    parent_tool_use_id: null,
    parent_agent_id: null
  };
}

test('Claude session usage deduplicates streamed assistant records and reports the current context', () => {
  const first = assistantMessage('message-1', {
    input_tokens: 10,
    output_tokens: 2,
    cache_creation_input_tokens: 3,
    cache_read_input_tokens: 4
  });
  const second = assistantMessage(
    'message-2',
    {
      input_tokens: 20,
      output_tokens: 5,
      cache_creation_input_tokens: 7,
      cache_read_input_tokens: 11
    },
    'claude-sonnet-5'
  );

  expect(claudeSessionUsage([first, first, second])).toEqual({
    total: 62,
    input: 55,
    output: 7,
    cachedInput: 15,
    context: { used: 43, window: 1_000_000 }
  });
});

test('Claude session usage reader requests the existing SDK transcript by session and workspace', async () => {
  const calls: unknown[] = [];
  const reader = createClaudeSessionUsageReader({
    getSessionMessages: async (...args) => {
      calls.push(args);
      return [assistantMessage('message-1', { input_tokens: 8, output_tokens: 3 })];
    }
  });

  expect(
    await reader({
      providerSessionRef: 'claude-session',
      workingPath: '/workspace',
      executable: '/usr/bin/claude'
    })
  ).toEqual({
    total: 11,
    input: 8,
    output: 3,
    cachedInput: 0,
    context: { used: 11, window: 1_000_000 }
  });
  expect(calls).toEqual([['claude-session', { dir: '/workspace', includeSystemMessages: true }]]);
});
