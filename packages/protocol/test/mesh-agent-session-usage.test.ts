import { expect, test } from 'bun:test';

import { meshAgentSessionUsageResponseSchema, meshAgentSessionUsageSchema } from '../src/index.ts';

test('session usage requires core totals and preserves adapter extensions', () => {
  expect(
    meshAgentSessionUsageSchema.parse({
      total: 600_426,
      input: 597_658,
      output: 2_768,
      cachedInput: 518_656,
      context: { used: 72_693, window: 258_400 }
    })
  ).toEqual({
    total: 600_426,
    input: 597_658,
    output: 2_768,
    cachedInput: 518_656,
    context: { used: 72_693, window: 258_400 }
  });
});

test('session usage response represents an adapter without the existing usage interface as no data', () => {
  expect(meshAgentSessionUsageResponseSchema.parse({ usage: null })).toEqual({ usage: null });
});
