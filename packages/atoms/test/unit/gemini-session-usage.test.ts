import { expect, test } from 'bun:test';

import { createGeminiSessionUsageReader, geminiSessionUsage } from '../../src/agent-adapters/gemini/session-usage.ts';

const GEMINI_SESSION = [
  JSON.stringify({ sessionId: 'gemini-session', kind: 'main' }),
  JSON.stringify({
    id: 'message-1',
    type: 'gemini',
    model: 'gemini-2.5-pro',
    tokens: { input: 100, output: 20, cached: 30, thoughts: 5, total: 125 }
  }),
  JSON.stringify({
    id: 'message-1',
    type: 'gemini',
    model: 'gemini-2.5-pro',
    tokens: { input: 100, output: 20, cached: 30, thoughts: 5, total: 125 }
  }),
  JSON.stringify({
    id: 'message-2',
    type: 'gemini',
    model: 'gemini-2.5-flash',
    tokens: { input: 200, output: 40, cached: 50, thoughts: 10, total: 250 }
  })
].join('\n');

test('Gemini session usage rebuilds current persisted model totals without counting message updates twice', () => {
  expect(geminiSessionUsage(GEMINI_SESSION)).toEqual({
    total: 375,
    input: 300,
    output: 60,
    cachedInput: 80,
    reasoningOutput: 15,
    context: { used: 200, window: 1_048_576 }
  });
});

test('Gemini session usage reader reads the existing provider session without launching the CLI', async () => {
  const calls: unknown[] = [];
  const reader = createGeminiSessionUsageReader({
    readSession: (context) => {
      calls.push(context);
      return GEMINI_SESSION;
    }
  });
  const context = {
    providerSessionRef: 'gemini-session',
    workingPath: '/workspace',
    executable: '/usr/bin/gemini'
  };

  expect(await reader(context)).toEqual({
    total: 375,
    input: 300,
    output: 60,
    cachedInput: 80,
    reasoningOutput: 15,
    context: { used: 200, window: 1_048_576 }
  });
  expect(calls).toEqual([context]);
});

test('Gemini session usage reader returns no data for a session without persisted usage', async () => {
  const reader = createGeminiSessionUsageReader({ readSession: () => null });

  expect(
    await reader({
      providerSessionRef: 'gemini-session',
      workingPath: '/workspace',
      executable: '/usr/bin/gemini'
    })
  ).toBeNull();
});
