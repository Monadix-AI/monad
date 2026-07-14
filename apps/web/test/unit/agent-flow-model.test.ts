import { expect, test } from 'bun:test';

import {
  agentFlowSummaries,
  appendPromptGuidance,
  deriveAgentFlowReadiness,
  validateAgentFlow
} from '#/features/studio/agent-workshop/agent-flow-model';

const baseInput = {
  name: 'Default Dev Agent',
  prompt: '',
  model: '',
  atomsMode: 'inherit' as const,
  atomsAllow: [],
  sandboxMode: '' as const,
  maxTurns: '',
  maxThinkingTokens: '',
  maxBudgetUsd: '',
  subagentCallable: false,
  isPublic: false,
  a2aEnabled: false
};

test('treats inherited settings as valid optional improvements', () => {
  expect(deriveAgentFlowReadiness(baseInput)).toEqual({
    label: 'Ready to use',
    optionalImprovements: 5,
    saveBlocked: false
  });
});

test('blocks save when the agent name is empty', () => {
  expect(deriveAgentFlowReadiness({ ...baseInput, name: '  ' })).toEqual({
    label: 'Needs attention',
    optionalImprovements: 5,
    saveBlocked: true
  });
});

test('validates safety limits without rejecting blank inherited values', () => {
  expect(validateAgentFlow({ ...baseInput, maxTurns: '', maxThinkingTokens: '', maxBudgetUsd: '' }).errors).toEqual({});
  expect(
    validateAgentFlow({ ...baseInput, maxTurns: '1.5', maxThinkingTokens: '-2', maxBudgetUsd: 'free' }).errors
  ).toEqual({
    maxBudgetUsd: 'Enter a number greater than 0.',
    maxThinkingTokens: 'Enter a number greater than 0.',
    maxTurns: 'Enter a whole number greater than 0.'
  });
});

test('appends guidance once as an editable prompt line', () => {
  expect(appendPromptGuidance('Be practical.', 'Ask before risky actions.')).toBe(
    'Be practical.\n\nAsk before risky actions.'
  );
  expect(appendPromptGuidance('Be practical.\nAsk before risky actions.', 'Ask before risky actions.')).toBe(
    'Be practical.\nAsk before risky actions.'
  );
});

test('derives plain-language summaries for inherited settings', () => {
  expect(agentFlowSummaries(baseInput)).toMatchObject({
    identity: ['Name: Default Dev Agent', 'Instructions: Add guidance'],
    model: ['Model: workspace default'],
    tools: ['Access: workspace capabilities'],
    safety: ['Safety: workspace default'],
    response: ['Style: Uses workspace defaults', 'Preview: Add instructions to shape responses']
  });
});

test('summarizes configured tools and availability', () => {
  const summaries = agentFlowSummaries({
    ...baseInput,
    atomsMode: 'allowlist',
    atomsAllow: ['filesystem', 'web'],
    sandboxMode: 'workspace',
    subagentCallable: true
  });

  expect(summaries.tools).toEqual(['Access: 2 selected capabilities']);
  expect(summaries.safety).toEqual(['Safety: workspace sandbox']);
  expect(summaries.response).toEqual([
    'Style: Uses workspace defaults',
    'Preview: Add instructions to shape responses',
    'Available to: other Monad agents'
  ]);
});
