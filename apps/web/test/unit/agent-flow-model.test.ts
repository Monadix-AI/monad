import { expect, test } from 'bun:test';

import {
  AGENT_FLOW_NODE_IDS,
  agentFlowSummaries,
  appendPromptGuidance,
  deriveAgentFlowReadiness,
  validateAgentFlow
} from '#/features/studio/agent-workshop/agent-flow-model';

test('keeps skills as a separate stage between tools and memory', () => {
  expect(AGENT_FLOW_NODE_IDS).toEqual(['identity', 'models', 'tools', 'skills', 'memory', 'sandbox', 'channels']);
});

const baseInput = {
  name: 'Default Dev Agent',
  instructions: { agent: '', user: '' },
  model: '',
  roles: {},
  atomsMode: 'inherit' as const,
  atomsAllow: [],
  skillsMode: 'inherit' as const,
  skillsAllow: [],
  mcpCount: 2,
  memory: { available: true, factCount: 0 },
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
  expect(agentFlowSummaries(baseInput)).toEqual({
    identity: ['Name: Default Dev Agent', 'Instructions: Add Markdown'],
    models: ['Profile: workspace default', 'Role overrides: none'],
    tools: ['Policy: inherit workspace', 'MCPs: 2 inherited'],
    skills: ['Policy: inherit workspace'],
    memory: ['Memory: available', 'Facts: 0'],
    sandbox: ['Sandbox: workspace default'],
    channels: ['Availability: private']
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

  expect(summaries.tools).toEqual(['Policy: 2 selected tools', 'MCPs: 2 inherited']);
  expect(summaries.sandbox).toEqual(['Sandbox: workspace']);
  expect(summaries.channels).toEqual(['Available to: subagents']);
});

test('summarizes instruction files, model overrides, memory, and channels', () => {
  expect(
    agentFlowSummaries({
      ...baseInput,
      instructions: { agent: 'Review code.', user: '' },
      model: 'balanced',
      roles: { memory: 'fast' },
      maxTurns: '8',
      memory: { available: true, factCount: 4 },
      a2aEnabled: true,
      isPublic: true
    })
  ).toEqual({
    identity: ['Name: Default Dev Agent', 'Instructions: AGENT.md'],
    models: ['Profile: balanced', 'Role override: 1', 'Limits: Max turns 8'],
    tools: ['Policy: inherit workspace', 'MCPs: 2 inherited'],
    skills: ['Policy: inherit workspace'],
    memory: ['Memory: available', 'Facts: 4'],
    sandbox: ['Sandbox: workspace default'],
    channels: ['Available to: public API, A2A']
  });
});

test('summarizes every configured agent execution limit independently from role overrides', () => {
  expect(
    agentFlowSummaries({
      ...baseInput,
      maxTurns: '12',
      maxThinkingTokens: '32000',
      maxBudgetUsd: '4.5'
    }).models
  ).toEqual([
    'Profile: workspace default',
    'Role overrides: none',
    'Limits: Max turns 12, Token budget 32000, Cost limit $4.5'
  ]);
});
