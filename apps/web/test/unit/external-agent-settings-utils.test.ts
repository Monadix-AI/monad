import { expect, test } from 'bun:test';

import { externalAgentReasoningEffortsForModel } from '../../src/features/studio/third-party-agents/external-agent-settings-utils';

test('external agent effort controls require successful probe data', () => {
  expect(externalAgentReasoningEffortsForModel(undefined, undefined, undefined)).toEqual([]);
  expect(externalAgentReasoningEffortsForModel([], undefined, 'gpt-5')).toEqual([]);
});

test('external agent effort controls use model-specific probe levels when available', () => {
  const byModel = { 'gpt-5': [' low ', 'high', 'high'] };

  expect(externalAgentReasoningEffortsForModel(['medium'], byModel, 'gpt-5')).toEqual(['low', 'high']);
  expect(externalAgentReasoningEffortsForModel(['medium'], byModel, 'unknown')).toEqual([]);
  expect(externalAgentReasoningEffortsForModel(['medium'], byModel, undefined)).toEqual(['medium']);
});
