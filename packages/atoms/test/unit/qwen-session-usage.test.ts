import { expect, test } from 'bun:test';

import { createQwenSessionUsageReader, qwenSessionUsage } from '../../src/agent-adapters/qwen/session-usage.ts';

test('Qwen session usage rebuilds current ChatRecord totals and uses its persisted context window', () => {
  const raw = [
    {
      uuid: 'record-1',
      sessionId: 'qwen-session',
      type: 'assistant',
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        cachedContentTokenCount: 30,
        thoughtsTokenCount: 5,
        totalTokenCount: 125
      },
      contextWindowSize: 131_072
    },
    {
      uuid: 'record-2',
      sessionId: 'qwen-session',
      type: 'assistant',
      usageMetadata: {
        promptTokenCount: 200,
        candidatesTokenCount: 40,
        cachedContentTokenCount: 50,
        thoughtsTokenCount: 10,
        totalTokenCount: 250
      },
      contextWindowSize: 262_144
    }
  ]
    .map((record) => JSON.stringify(record))
    .join('\n');

  expect(qwenSessionUsage(raw)).toEqual({
    total: 375,
    input: 300,
    output: 60,
    cachedInput: 80,
    reasoningOutput: 15,
    context: { used: 200, window: 262_144 }
  });
});

test('Qwen session usage reader returns no data for a session without persisted usage', async () => {
  const reader = createQwenSessionUsageReader({ readSession: () => null });

  expect(
    await reader({
      providerSessionRef: 'qwen-session',
      workingPath: '/workspace',
      executable: '/usr/bin/qwen'
    })
  ).toBeNull();
});
