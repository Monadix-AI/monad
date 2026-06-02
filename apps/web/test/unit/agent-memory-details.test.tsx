import { describe, expect, test } from 'bun:test';

import { agentMemoryScope, agentMemoryViewState } from '../../src/features/studio/agent-details/AgentMemoryDetails.tsx';

describe('Agent Memory details policy', () => {
  test('uses the selected Agent scope for Facts, Graph, and Laws reads', () => {
    expect(agentMemoryScope({ id: 'agt_000000000001' })).toEqual({
      scopeKind: 'agent',
      scopeId: 'agt_000000000001'
    });
  });

  test('keeps historical tabs inspectable while Memory is off', () => {
    const memory = { enabled: false, advanced: false, autoConsolidate: false, intervalMinutes: 30 };

    expect(agentMemoryViewState(memory, 'facts')).toBe('historical');
    expect(agentMemoryViewState(memory, 'graph')).toBe('historical');
    expect(agentMemoryViewState(memory, 'laws')).toBe('historical');
  });

  test('gates advanced tabs only by the Agent preference', () => {
    const basicMemory = { enabled: true, advanced: false, autoConsolidate: false, intervalMinutes: 30 };
    const advancedMemory = { ...basicMemory, advanced: true };

    expect(agentMemoryViewState(basicMemory, 'facts')).toBe('available');
    expect(agentMemoryViewState(basicMemory, 'graph')).toBe('advanced-required');
    expect(agentMemoryViewState(advancedMemory, 'graph')).toBe('available');
    expect(agentMemoryViewState(advancedMemory, 'laws')).toBe('available');
  });
});
