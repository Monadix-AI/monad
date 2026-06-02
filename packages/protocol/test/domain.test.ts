import { expect, test } from 'bun:test';

import { finishReasonSchema } from '../src/domain.ts';

const VALID = ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'] as const;

test.each([...VALID])('finishReasonSchema accepts "%s"', (reason) => {
  expect(finishReasonSchema.safeParse(reason).success).toBe(true);
});

test('finishReasonSchema rejects unknown values from the AI SDK', () => {
  for (const unknown of ['stop', 'length', 'content_filter', '']) {
    expect(finishReasonSchema.safeParse(unknown).success).toBe(false);
  }
});
