import type { AgentId, AgentMemorySettings } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { createDefaultConfig } from '@monad/environment';

import {
  resolveAgentMemoryPolicy,
  resolveSessionMemoryPolicy,
  selectBackgroundConsolidationTargets
} from '#/services/memory/policy.ts';

const AGENT_ID = 'agt_000000000001' as AgentId;

function configWith(memory: AgentMemorySettings) {
  const config = createDefaultConfig('test');
  config.agent.agents.push({
    id: AGENT_ID,
    name: 'Memory Agent',
    capabilities: [],
    credentialIds: [],
    declaredScopes: [],
    atoms: { mode: 'inherit', allow: [], deny: [] },
    visibility: { subagentCallable: false, public: false },
    a2a: { enabled: false },
    monadix: { consume: false },
    memory
  });
  return config;
}

test.each([
  [{ enabled: false, advanced: true, autoConsolidate: true, intervalMinutes: 30 }, 0],
  [{ enabled: true, advanced: false, autoConsolidate: false, intervalMinutes: 30 }, 1],
  [{ enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 }, 3]
] as const)('resolves %o to L%i without a global depth gate', (memory, expected) => {
  expect(resolveAgentMemoryPolicy(configWith(memory), AGENT_ID).effectiveLevel).toBe(expected);
});

test('missing agents and agentless sessions resolve disabled without borrowing another Agent', () => {
  const config = configWith({
    enabled: true,
    advanced: true,
    autoConsolidate: false,
    intervalMinutes: 30
  });
  expect(resolveAgentMemoryPolicy(config, 'agt_000000000002' as AgentId)).toEqual({
    agentId: null,
    effectiveLevel: 0,
    enabled: false,
    advanced: false
  });
  expect(resolveSessionMemoryPolicy(config, { agentIds: [] }).effectiveLevel).toBe(0);
});

test('background consolidation includes only targets owned by memory-enabled Agents', () => {
  const config = configWith({
    enabled: false,
    advanced: true,
    autoConsolidate: true,
    intervalMinutes: 30
  });
  expect(
    selectBackgroundConsolidationTargets(config, [
      { id: 'disabled-session', agentId: AGENT_ID, projectKey: 'workspace' },
      { id: 'shared-project', agentId: null, projectKey: 'workspace' }
    ])
  ).toEqual([]);
});
