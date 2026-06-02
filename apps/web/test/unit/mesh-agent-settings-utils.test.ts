import { expect, test } from 'bun:test';

import { meshAgentReasoningEffortsForModel } from '../../src/features/studio/third-party-agents/mesh-agent-settings-utils';

test('MeshAgent effort controls require successful probe data', () => {
  expect(meshAgentReasoningEffortsForModel(undefined, undefined, undefined)).toEqual([]);
  expect(meshAgentReasoningEffortsForModel([], undefined, 'gpt-5')).toEqual([]);
});

test('MeshAgent effort controls use model-specific probe levels when available', () => {
  const byModel = { 'gpt-5': [' low ', 'high', 'high'] };

  expect(meshAgentReasoningEffortsForModel(['medium'], byModel, 'gpt-5')).toEqual(['low', 'high']);
  expect(meshAgentReasoningEffortsForModel(['medium'], byModel, 'unknown')).toEqual([]);
  expect(meshAgentReasoningEffortsForModel(['medium'], byModel, undefined)).toEqual(['medium']);
});
