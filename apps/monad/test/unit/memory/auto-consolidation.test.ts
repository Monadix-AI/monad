import type { AgentId, AgentMemorySettings } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { dueAutoConsolidationAgentIds } from '#/agent/memory/auto-consolidation.ts';

const MIN = 60_000;
const agentA = 'agt_000000000001' as AgentId;
const agentB = 'agt_000000000002' as AgentId;
const agentC = 'agt_000000000003' as AgentId;
const removedAgent = 'agt_000000000004' as AgentId;
const memory: AgentMemorySettings = {
  enabled: true,
  advanced: true,
  autoConsolidate: true,
  intervalMinutes: 30
};

test('selects independently due Agents and prunes removed timestamps', () => {
  const lastRunByAgent = new Map<AgentId, number>([
    [agentA, 0],
    [agentB, 0],
    [agentC, 0],
    [removedAgent, 0]
  ]);

  expect(
    dueAutoConsolidationAgentIds(
      [
        { id: agentA, memory: { ...memory, intervalMinutes: 10 } },
        { id: agentB, memory: { ...memory, intervalMinutes: 60 } },
        { id: agentC, memory: { ...memory, autoConsolidate: false } }
      ],
      lastRunByAgent,
      30 * MIN
    )
  ).toEqual([agentA]);
  expect([...lastRunByAgent.keys()]).toEqual([agentA, agentB, agentC]);
});

test('seeds a new Agent at the current time without running immediately', () => {
  const lastRunByAgent = new Map<AgentId, number>();

  expect(dueAutoConsolidationAgentIds([{ id: agentA, memory }], lastRunByAgent, 30 * MIN)).toEqual([]);
  expect(lastRunByAgent.get(agentA)).toBe(30 * MIN);
});
