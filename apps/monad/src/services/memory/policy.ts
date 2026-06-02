import type { MonadConfig } from '@monad/environment';
import type { AgentId, OptionalMemoryScopeQuery, Session } from '@monad/protocol';

export interface EffectiveAgentMemoryPolicy {
  agentId: AgentId | null;
  effectiveLevel: 0 | 1 | 2 | 3;
  enabled: boolean;
  advanced: boolean;
}

export interface AgentMemoryConsolidationTarget {
  id: string;
  agentId: AgentId | null;
  projectKey: string | null;
}

type MemoryPolicyConfig = Pick<MonadConfig, 'agent' | 'memory'>;

export function memoryScopeKey(query?: OptionalMemoryScopeQuery): string | undefined {
  if (!query?.scopeKind || !query.scopeId) return undefined;
  return query.scopeKind === 'global' ? 'global' : `${query.scopeKind}:${query.scopeId}`;
}

const disabledPolicy = (): EffectiveAgentMemoryPolicy => ({
  agentId: null,
  effectiveLevel: 0,
  enabled: false,
  advanced: false
});

export function resolveAgentMemoryPolicy(
  cfg: MemoryPolicyConfig,
  agentId: AgentId | null | undefined
): EffectiveAgentMemoryPolicy {
  if (!agentId) return disabledPolicy();
  const agent = cfg.agent.agents.find((candidate) => candidate.id === agentId);
  if (!agent) return disabledPolicy();
  const effectiveLevel = !agent.memory.enabled ? 0 : agent.memory.advanced ? 3 : 1;
  return {
    agentId,
    effectiveLevel,
    enabled: agent.memory.enabled,
    advanced: agent.memory.advanced
  };
}

export function resolveSessionMemoryPolicy(
  cfg: MemoryPolicyConfig,
  session: Pick<Session, 'agentIds'>
): EffectiveAgentMemoryPolicy {
  return resolveAgentMemoryPolicy(cfg, session.agentIds[0] as AgentId | undefined);
}

export function selectAgentConsolidationTargets<T extends AgentMemoryConsolidationTarget>(
  targets: readonly T[],
  agentId: AgentId
): T[] {
  return targets.filter((target) => target.agentId === agentId);
}

export function selectBackgroundConsolidationTargets<T extends AgentMemoryConsolidationTarget>(
  cfg: MemoryPolicyConfig,
  targets: readonly T[]
): T[] {
  const enabled = new Set(cfg.agent.agents.filter((agent) => agent.memory.enabled).map((agent) => agent.id as AgentId));
  return targets.filter((target) => target.agentId !== null && enabled.has(target.agentId));
}
