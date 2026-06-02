import type { Agent } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { buildAgentEditorUpdate } from '#/features/studio/agent-workshop/agent-editor-update';

const agent = {
  id: 'agt_100000000000',
  name: 'Reviewer',
  capabilities: [],
  credentialIds: [],
  declaredScopes: [],
  memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 },
  visibility: { subagentCallable: false, public: false },
  a2a: { enabled: false },
  monadix: { consume: false }
} satisfies Agent;

test('agent editor update includes per-agent A2A exposure setting', () => {
  const patch = buildAgentEditorUpdate({
    agent,
    agentId: agent.id,
    atomsAllow: [],
    atomsMode: 'inherit',
    credentialIds: ['credential-github'],
    isPublic: false,
    memoryEnabled: false,
    advancedMemoryEnabled: true,
    memoryAutoConsolidate: true,
    memoryIntervalMinutes: '45',
    maxBudgetUsd: '',
    maxThinkingTokens: '',
    maxTurns: '',
    model: '',
    name: 'Reviewer',
    roles: {},
    sandboxMode: '',
    skillsAllow: ['global:review'],
    skillsAutoload: true,
    skillsDisabled: ['global:disabled'],
    skillsMode: 'allowlist',
    subagentCallable: false,
    a2aEnabled: true,
    monadixConsume: true
  });

  expect(patch).toEqual({
    agentId: agent.id,
    name: 'Reviewer',
    model: undefined,
    sandboxMode: undefined,
    maxTurns: undefined,
    maxThinkingTokens: undefined,
    maxBudgetUsd: undefined,
    roles: {},
    memory: { enabled: false, advanced: true, autoConsolidate: true, intervalMinutes: 45 },
    atoms: { mode: 'inherit', allow: [], deny: [] },
    skills: {
      mode: 'allowlist',
      allow: ['global:review'],
      autoload: true,
      disabled: ['global:disabled']
    },
    visibility: { subagentCallable: false, public: false },
    a2a: { enabled: true },
    credentialIds: ['credential-github'],
    monadix: { consume: true }
  });
});
