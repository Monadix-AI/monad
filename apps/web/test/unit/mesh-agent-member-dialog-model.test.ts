import { expect, test } from 'bun:test';

import {
  meshAgentMemberDialogStateForMember,
  meshAgentModelDisplayName,
  meshAgentModelSupportsSpeed
} from '../../src/features/workplace/project-shell/mesh-agent-member-dialog-model';

test('MeshAgent member dialog formats first party model names', () => {
  expect(meshAgentModelDisplayName('gpt-5-codex')).toBe('GPT-5-Codex');
  expect(meshAgentModelDisplayName('claude-opus-4-5')).toBe('Opus 4.5');
  expect(meshAgentModelDisplayName('qwen3-coder')).toBe('qwen3-coder');
});

test('MeshAgent member dialog enables fast mode only for an explicitly supported model', () => {
  const candidate = {
    executionCapabilities: { autopilot: true, fastMode: true },
    speedsByModel: { default: ['fast'], 'gpt-fast': ['fast'] }
  } as Parameters<typeof meshAgentModelSupportsSpeed>[0];

  expect([
    meshAgentModelSupportsSpeed(candidate, 'gpt-fast', 'fast'),
    meshAgentModelSupportsSpeed(candidate, 'gpt-standard', 'fast'),
    meshAgentModelSupportsSpeed(candidate, undefined, 'fast')
  ]).toEqual([true, false, true]);
});

test('MeshAgent member dialog resolves the provider used by an existing member', () => {
  const room = {
    availableProjectMembers: [
      {
        id: 'mesh-agent:codex',
        type: 'mesh-agent',
        name: 'codex',
        label: 'OpenAI Codex',
        tag: 'Codex',
        enabled: true,
        modelOptions: [],
        reasoningEfforts: []
      }
    ]
  } as unknown as Parameters<typeof meshAgentMemberDialogStateForMember>[0];

  const state = meshAgentMemberDialogStateForMember(room, {
    id: 'pmem_codex_tester',
    type: 'mesh-agent',
    name: 'Tester',
    templateName: 'codex',
    projectTemplateId: 'tester',
    displayName: 'Tester',
    instanceId: 'pmem_codex_tester'
  });

  expect(state?.candidate.id).toBe('mesh-agent:codex');
});
