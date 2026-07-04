import { expect, test } from 'bun:test';

import {
  nativeCliMemberDialogStateForMember,
  nativeCliModelDisplayName
} from '../../features/workplace/project-shell/native-cli-member-dialog-model';

test('native CLI member dialog formats first party model names', () => {
  expect(nativeCliModelDisplayName('gpt-5-codex')).toBe('GPT-5-Codex');
  expect(nativeCliModelDisplayName('claude-opus-4-5')).toBe('Opus 4.5');
  expect(nativeCliModelDisplayName('qwen3-coder')).toBe('qwen3-coder');
});

test('native CLI member dialog resolves the project template used by an existing member', () => {
  const room = {
    availableProjectMembers: [
      {
        id: 'native-cli-template:codex:reviewer',
        type: 'native-cli',
        name: 'codex',
        label: 'Reviewer',
        tag: 'Codex',
        enabled: true,
        modelOptions: [],
        reasoningEfforts: [],
        template: { id: 'reviewer', displayName: 'Reviewer' }
      },
      {
        id: 'native-cli-template:codex:tester',
        type: 'native-cli',
        name: 'codex',
        label: 'Tester',
        tag: 'Codex',
        enabled: true,
        modelOptions: [],
        reasoningEfforts: [],
        template: { id: 'tester', displayName: 'Tester' }
      }
    ]
  } as unknown as Parameters<typeof nativeCliMemberDialogStateForMember>[0];

  const state = nativeCliMemberDialogStateForMember(room, {
    id: 'pmem_codex_tester',
    type: 'native-cli',
    name: 'Tester',
    templateName: 'codex',
    projectTemplateId: 'tester',
    displayName: 'Tester',
    instanceId: 'pmem_codex_tester'
  });

  expect(state?.candidate.id).toBe('native-cli-template:codex:tester');
});
