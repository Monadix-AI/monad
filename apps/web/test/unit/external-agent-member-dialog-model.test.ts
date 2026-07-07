import { expect, test } from 'bun:test';

import {
  externalAgentMemberDialogStateForMember,
  externalAgentModelDisplayName
} from '../../features/workplace/project-shell/external-agent-member-dialog-model';

test('external agent member dialog formats first party model names', () => {
  expect(externalAgentModelDisplayName('gpt-5-codex')).toBe('GPT-5-Codex');
  expect(externalAgentModelDisplayName('claude-opus-4-5')).toBe('Opus 4.5');
  expect(externalAgentModelDisplayName('qwen3-coder')).toBe('qwen3-coder');
});

test('external agent member dialog resolves the project template used by an existing member', () => {
  const room = {
    availableProjectMembers: [
      {
        id: 'external-agent-template:codex:reviewer',
        type: 'external-agent',
        name: 'codex',
        label: 'Reviewer',
        tag: 'Codex',
        enabled: true,
        modelOptions: [],
        reasoningEfforts: [],
        template: { id: 'reviewer', displayName: 'Reviewer' }
      },
      {
        id: 'external-agent-template:codex:tester',
        type: 'external-agent',
        name: 'codex',
        label: 'Tester',
        tag: 'Codex',
        enabled: true,
        modelOptions: [],
        reasoningEfforts: [],
        template: { id: 'tester', displayName: 'Tester' }
      }
    ]
  } as unknown as Parameters<typeof externalAgentMemberDialogStateForMember>[0];

  const state = externalAgentMemberDialogStateForMember(room, {
    id: 'pmem_codex_tester',
    type: 'external-agent',
    name: 'Tester',
    templateName: 'codex',
    projectTemplateId: 'tester',
    displayName: 'Tester',
    instanceId: 'pmem_codex_tester'
  });

  expect(state?.candidate.id).toBe('external-agent-template:codex:tester');
});
