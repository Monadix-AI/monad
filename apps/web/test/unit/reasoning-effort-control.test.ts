import { expect, test } from 'bun:test';

import { defaultReasoningEffort } from '../../src/components/ReasoningEffortControl.tsx';

test('default reasoning effort uses the second available effort from low-to-high provider metadata', () => {
  expect(defaultReasoningEffort(['low', 'medium', 'high', 'xhigh', 'max'])).toBe('medium');
  expect(defaultReasoningEffort(['low'])).toBe('low');
});
