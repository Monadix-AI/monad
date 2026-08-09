import type { MeshAgentConfig, MonadConfig } from '@monad/environment';
import type { MeshAgentView } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  invitableMeshAgentConfigs,
  resolveInvitableMeshAgentConfig,
  toInvitableMeshAgent
} from '../../src/services/mesh-agent/invitable-agents.ts';

const agentId = 'agt_000000000000';
const codex: MeshAgentConfig = {
  name: 'codex',
  provider: 'codex',
  command: 'codex',
  enabled: true,
  allowAutopilot: false,
  approvalOwnership: 'provider-owned'
};
const legacyMonad: MeshAgentConfig = {
  name: 'legacy-monad-reviewer',
  displayName: 'Old Reviewer',
  provider: 'monad',
  command: 'monad',
  enabled: true,
  allowAutopilot: true,
  approvalOwnership: 'provider-owned',
  adapterSettings: { agentId },
  discovery: {
    connectorName: 'monad',
    externalId: agentId,
    state: 'available'
  }
};

function config(meshAgents: MeshAgentConfig[] = [codex, legacyMonad]): MonadConfig {
  return {
    agent: {
      agents: [{ id: agentId, name: 'Reviewer' }]
    },
    meshAgents
  } as unknown as MonadConfig;
}

test('invitable runtime catalog retains configured providers and derives Monad Agents without legacy duplicates', () => {
  const result = invitableMeshAgentConfigs(config(), {
    command: 'bun',
    args: ['/repo/apps/cli/src/main.ts']
  });

  expect(result).toEqual([
    codex,
    {
      name: `monad--${agentId}`,
      displayName: 'Reviewer',
      provider: 'monad',
      command: 'bun',
      args: ['/repo/apps/cli/src/main.ts'],
      enabled: true,
      allowAutopilot: false,
      approvalOwnership: 'provider-owned',
      adapterSettings: { agentId }
    }
  ]);
  expect(resolveInvitableMeshAgentConfig(config(), `monad--${agentId}`, { command: 'bun', args: [] })).toEqual({
    name: `monad--${agentId}`,
    displayName: 'Reviewer',
    provider: 'monad',
    command: 'bun',
    args: [],
    enabled: true,
    allowAutopilot: false,
    approvalOwnership: 'provider-owned',
    adapterSettings: { agentId }
  });
});

test('invitable runtime resolution stops resolving a removed Monad Agent', () => {
  const removed = {
    ...config([]),
    agent: { agents: [] }
  } as unknown as MonadConfig;

  expect(resolveInvitableMeshAgentConfig(removed, `monad--${agentId}`, { command: 'bun', args: [] })).toBeUndefined();
});

test('invitable public projection excludes runtime configuration and provider discovery state', () => {
  const view: MeshAgentView = {
    name: 'codex',
    displayName: 'Reviewer',
    provider: 'codex',
    productIcon: 'codex',
    command: '/usr/local/bin/codex',
    args: ['--profile', 'work'],
    env: { API_KEY: 'secret' },
    modelOptions: ['gpt-5.5'],
    modelOptionDisplayNames: { 'gpt-5.5': 'GPT-5.5' },
    speedsByModel: { 'gpt-5.5': ['fast'] },
    reasoningEfforts: ['high'],
    reasoningEffortsByModel: { 'gpt-5.5': ['high'] },
    enabled: true,
    allowAutopilot: false,
    approvalOwnership: 'provider-owned',
    adapterSettings: { configProfile: 'work' },
    discovery: { connectorName: 'codex', externalId: 'reviewer', state: 'available' },
    settings: [{ key: 'profile', label: 'Profile', kind: 'text' }]
  };

  expect(
    toInvitableMeshAgent(view, 'configured-mesh-agent', { title: 'Codex adapter', path: 'M1 1h22v22H1z' })
  ).toEqual({
    name: 'codex',
    displayName: 'Reviewer',
    provider: 'codex',
    productIcon: 'codex',
    icon: { title: 'Codex adapter', path: 'M1 1h22v22H1z' },
    enabled: true,
    allowAutopilot: false,
    modelOptions: ['gpt-5.5'],
    modelOptionDisplayNames: { 'gpt-5.5': 'GPT-5.5' },
    speedsByModel: { 'gpt-5.5': ['fast'] },
    reasoningEfforts: ['high'],
    reasoningEffortsByModel: { 'gpt-5.5': ['high'] },
    settings: [{ key: 'profile', label: 'Profile', kind: 'text' }],
    source: 'configured-mesh-agent'
  });
});
