import type { Agent } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { buildAgentEditorUpdate } from '#/features/studio/agent-workshop/agent-editor-update';

const agent = {
  id: 'agt_100000000000',
  name: 'Reviewer',
  capabilities: [],
  declaredScopes: [],
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
    description: '',
    isPublic: false,
    maxBudgetUsd: '',
    maxThinkingTokens: '',
    maxTurns: '',
    model: '',
    name: 'Reviewer',
    roles: {},
    sandboxMode: '',
    subagentCallable: false,
    a2aEnabled: true,
    monadixConsume: true
  });

  expect(patch).toMatchObject({
    agentId: agent.id,
    a2a: { enabled: true },
    visibility: { subagentCallable: false, public: false }
  });
});
