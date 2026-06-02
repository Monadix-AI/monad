import type { Agent, AgentId } from '@monad/protocol';

import { agentAutoConsolidationDue } from '#/services/memory/graph/service.ts';

type AutoConsolidationAgent = Pick<Agent, 'id' | 'memory'>;

export function dueAutoConsolidationAgentIds(
  agents: readonly AutoConsolidationAgent[],
  lastRunByAgent: Map<AgentId, number>,
  nowMs: number
): AgentId[] {
  const activeIds = new Set(agents.map((agent) => agent.id as AgentId));
  for (const agentId of lastRunByAgent.keys()) {
    if (!activeIds.has(agentId)) lastRunByAgent.delete(agentId);
  }

  const due: AgentId[] = [];
  for (const agent of agents) {
    const agentId = agent.id as AgentId;
    const lastRun = lastRunByAgent.get(agentId);
    if (lastRun === undefined) {
      lastRunByAgent.set(agentId, nowMs);
      continue;
    }
    if (agentAutoConsolidationDue(agent.memory, lastRun, nowMs)) due.push(agentId);
  }
  return due;
}
