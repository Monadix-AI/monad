import { expect, test } from 'bun:test';

import { observationSessionUsageMeter } from '../../src/workplace-experiences/chat-room/components/observation/session-usage-meter.ts';

test('session usage projects context and supported Codex token details', () => {
  expect(
    observationSessionUsageMeter({
      total: 600_426,
      input: 597_658,
      output: 2_768,
      cachedInput: 518_656,
      reasoningOutput: 845,
      context: { used: 72_693, window: 258_400 }
    })
  ).toEqual({
    total: 600_426,
    input: 597_658,
    output: 2_768,
    cachedInput: 518_656,
    reasoningOutput: 845,
    contextUsed: 72_693,
    contextWindow: 258_400,
    contextPercent: 28,
    contextMeterPercent: 28
  });
});

test('session usage hides the meter without a valid adapter context window', () => {
  expect([
    observationSessionUsageMeter(undefined),
    observationSessionUsageMeter({ total: 3, input: 2, output: 1 }),
    observationSessionUsageMeter({ total: 3, input: 2, output: 1, context: { used: 2, window: 0 } }),
    observationSessionUsageMeter({ total: 3, input: 2, output: 1, context: { used: '2', window: 4 } })
  ]).toEqual([null, null, null, null]);
});

test('session usage keeps the label percentage while clamping circular progress', () => {
  expect(
    observationSessionUsageMeter({
      total: 130,
      input: 100,
      output: 30,
      cachedInput: 'unknown',
      reasoningOutput: -1,
      context: { used: 130, window: 100 }
    })
  ).toEqual({
    total: 130,
    input: 100,
    output: 30,
    contextUsed: 130,
    contextWindow: 100,
    contextPercent: 130,
    contextMeterPercent: 100
  });
});
