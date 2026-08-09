import type { MeshAgentConfig, MonadConfig } from '@monad/environment';
import type { ChannelIcon, InvitableMeshAgent, MeshAgentView, NativeAgentMonadCliEntry } from '@monad/protocol';

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { discoveredMeshAgentName } from '#/services/mesh-agent/discovery.ts';

export interface InvitableMeshAgentEntry {
  config: MeshAgentConfig;
  source: InvitableMeshAgent['source'];
}

export function resolveDaemonMonadCliEntry(): NativeAgentMonadCliEntry {
  const cliSourceEntry = join(import.meta.dir, '../../../../cli/src/main.ts');
  if (existsSync(cliSourceEntry)) return { command: 'bun', args: [cliSourceEntry] };
  return { command: process.execPath, args: [] };
}

function derivedMonadMeshAgent(
  agent: MonadConfig['agent']['agents'][number],
  cliEntry: NativeAgentMonadCliEntry
): MeshAgentConfig {
  return {
    name: discoveredMeshAgentName('monad', agent.id),
    displayName: agent.name,
    provider: 'monad',
    command: cliEntry.command,
    args: cliEntry.args,
    enabled: true,
    allowAutopilot: false,
    approvalOwnership: 'provider-owned',
    adapterSettings: { agentId: agent.id }
  };
}

export function invitableMeshAgentEntries(
  cfg: MonadConfig,
  cliEntry: NativeAgentMonadCliEntry = resolveDaemonMonadCliEntry()
): InvitableMeshAgentEntry[] {
  const monadAgentIds = new Set<string>(cfg.agent.agents.map((agent) => agent.id));
  const configured = cfg.meshAgents
    .filter((agent) => {
      const agentId = agent.adapterSettings?.agentId;
      return !(agent.provider === 'monad' && typeof agentId === 'string' && monadAgentIds.has(agentId));
    })
    .map((config) => ({ config, source: 'configured-mesh-agent' as const }));
  const derived = cfg.agent.agents.map((agent) => ({
    config: derivedMonadMeshAgent(agent, cliEntry),
    source: 'monad-agent' as const
  }));
  return [...configured, ...derived];
}

export function invitableMeshAgentConfigs(
  cfg: MonadConfig,
  cliEntry: NativeAgentMonadCliEntry = resolveDaemonMonadCliEntry()
): MeshAgentConfig[] {
  return invitableMeshAgentEntries(cfg, cliEntry).map((entry) => entry.config);
}

export function enabledInvitableMeshAgentConfigs(
  cfg: MonadConfig,
  cliEntry: NativeAgentMonadCliEntry = resolveDaemonMonadCliEntry()
): MeshAgentConfig[] {
  return invitableMeshAgentConfigs(cfg, cliEntry).filter((agent) => agent.enabled !== false);
}

export function resolveInvitableMeshAgentConfig(
  cfg: MonadConfig,
  name: string,
  cliEntry: NativeAgentMonadCliEntry = resolveDaemonMonadCliEntry()
): MeshAgentConfig | undefined {
  return enabledInvitableMeshAgentConfigs(cfg, cliEntry).find((agent) => agent.name === name);
}

export function toInvitableMeshAgent(
  view: MeshAgentView,
  source: InvitableMeshAgent['source'],
  icon?: ChannelIcon
): InvitableMeshAgent {
  return {
    name: view.name,
    ...(view.displayName ? { displayName: view.displayName } : {}),
    provider: view.provider,
    ...(view.productIcon ? { productIcon: view.productIcon } : {}),
    ...(icon ? { icon } : {}),
    enabled: view.enabled,
    allowAutopilot: view.allowAutopilot,
    ...(view.capabilities ? { capabilities: view.capabilities } : {}),
    ...(view.modelOptions ? { modelOptions: view.modelOptions } : {}),
    ...(view.modelOptionDisplayNames ? { modelOptionDisplayNames: view.modelOptionDisplayNames } : {}),
    ...(view.speedsByModel ? { speedsByModel: view.speedsByModel } : {}),
    ...(view.reasoningEfforts ? { reasoningEfforts: view.reasoningEfforts } : {}),
    ...(view.reasoningEffortsByModel ? { reasoningEffortsByModel: view.reasoningEffortsByModel } : {}),
    ...(view.settings ? { settings: view.settings } : {}),
    source
  };
}
