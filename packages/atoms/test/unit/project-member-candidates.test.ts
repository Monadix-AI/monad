import { expect, test } from 'bun:test';

import { projectMemberCandidates } from '../../src/workspace-experiences/experience/project-projection.ts';

test('project member candidates include project templates defined on external agents', () => {
  const candidates = projectMemberCandidates({
    acpAgents: [],
    projectMembers: [],
    externalAgents: [
      {
        name: 'codex',
        provider: 'codex',
        productIcon: 'codex',
        command: 'codex',
        enabled: true,
        defaultLaunchMode: 'app-server',
        allowAutopilot: false,
        approvalOwnership: 'provider-owned',
        modelOptions: ['gpt-5.5'],
        reasoningEfforts: ['medium', 'high'],
        projectTemplates: [
          {
            id: 'reviewer',
            displayName: 'Reviewer',
            modelId: 'gpt-5.5',
            reasoningEffort: 'high',
            speed: 'fast',
            customPrompt: 'Review changes only.'
          }
        ]
      }
    ]
  });

  expect(candidates).toContainEqual(
    expect.objectContaining({
      id: 'external-agent-template:codex:reviewer',
      type: 'external-agent',
      name: 'codex',
      label: 'Reviewer',
      tag: 'Codex',
      enabled: true,
      provider: 'codex',
      modelOptions: ['gpt-5.5'],
      reasoningEfforts: ['medium', 'high'],
      template: {
        id: 'reviewer',
        displayName: 'Reviewer',
        modelId: 'gpt-5.5',
        reasoningEffort: 'high',
        speed: 'fast',
        customPrompt: 'Review changes only.'
      }
    })
  );
});
