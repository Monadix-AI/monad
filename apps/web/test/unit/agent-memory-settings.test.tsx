import type { Agent } from '@monad/protocol';

import { describe, expect, test } from 'bun:test';

import {
  effectiveAgentMemoryLevel,
  memoryAfterAdvancedToggle,
  memoryAfterAutoConsolidateToggle,
  memoryAfterEnabledToggle,
  memoryAfterIntervalChange
} from '../../src/features/studio/memory-settings/AgentMemorySettingsSection.tsx';
import { memoryDataScopeForSelection } from '../../src/features/studio/memory-settings/MemoryDataScopePicker.tsx';

const agent = {
  id: 'agt_000000000001',
  name: 'Researcher',
  capabilities: [],
  credentialIds: [],
  declaredScopes: [],
  memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 },
  visibility: { subagentCallable: false, public: false },
  a2a: { enabled: false },
  monadix: { consume: false }
} satisfies Agent;

describe('By-Agent Memory settings', () => {
  test('turning Memory off preserves the Advanced preference for re-enable', () => {
    const disabled = memoryAfterEnabledToggle(agent.memory, false);
    expect(disabled).toEqual({ ...agent.memory, enabled: false });
    expect(memoryAfterEnabledToggle(disabled, true)).toEqual(agent.memory);
  });

  test('Advanced changes never rewrite the Memory enabled value', () => {
    expect(memoryAfterAdvancedToggle({ ...agent.memory, enabled: false }, false)).toEqual({
      ...agent.memory,
      enabled: false,
      advanced: false
    });
  });

  test('automatic consolidation changes preserve the rest of Agent Memory settings', () => {
    expect(memoryAfterAutoConsolidateToggle(agent.memory, true)).toEqual({
      ...agent.memory,
      autoConsolidate: true
    });
    expect(memoryAfterIntervalChange(agent.memory, 45)).toEqual({
      ...agent.memory,
      intervalMinutes: 45
    });
  });

  test('derives effective L0, L1, and shared advanced levels', () => {
    expect(
      effectiveAgentMemoryLevel({
        ...agent,
        memory: { enabled: false, advanced: true, autoConsolidate: false, intervalMinutes: 30 }
      })
    ).toBe(0);
    expect(
      effectiveAgentMemoryLevel({
        ...agent,
        memory: { enabled: true, advanced: false, autoConsolidate: false, intervalMinutes: 30 }
      })
    ).toBe(1);
    expect(effectiveAgentMemoryLevel(agent)).toBe(3);
  });

  test('All removes scope while an Agent selection creates one shared Graph/Laws scope', () => {
    expect(memoryDataScopeForSelection('__all__')).toBeUndefined();
    expect(memoryDataScopeForSelection(agent.id)).toEqual({
      scopeKind: 'agent',
      scopeId: agent.id
    });
  });
});
