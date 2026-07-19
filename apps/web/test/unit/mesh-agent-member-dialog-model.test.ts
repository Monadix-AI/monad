import { expect, test } from 'bun:test';

import {
  meshAgentMemberDialogStateForMember,
  meshAgentModelDisplayName
} from '../../src/features/workplace/project-shell/mesh-agent-member-dialog-model';

test('MeshAgent member dialog formats first party model names', () => {
  expect(meshAgentModelDisplayName('gpt-5-codex')).toBe('GPT-5-Codex');
  expect(meshAgentModelDisplayName('claude-opus-4-5')).toBe('Opus 4.5');
  expect(meshAgentModelDisplayName('qwen3-coder')).toBe('qwen3-coder');
});

test('MeshAgent member dialog resolves the project template used by an existing member', () => {
  const room = {
    availableProjectMembers: [
      {
        id: 'mesh-agent-template:codex:reviewer',
        type: 'mesh-agent',
        name: 'codex',
        label: 'Reviewer',
        tag: 'Codex',
        enabled: true,
        modelOptions: [],
        reasoningEfforts: [],
        template: { id: 'reviewer', displayName: 'Reviewer' }
      },
      {
        id: 'mesh-agent-template:codex:tester',
        type: 'mesh-agent',
        name: 'codex',
        label: 'Tester',
        tag: 'Codex',
        enabled: true,
        modelOptions: [],
        reasoningEfforts: [],
        template: { id: 'tester', displayName: 'Tester' }
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

  expect(state?.candidate.id).toBe('mesh-agent-template:codex:tester');
});
