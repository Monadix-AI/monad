import { expect, test } from 'bun:test';

import { projectMemberCandidates } from '../../src/workspace-experiences/experience/project-projection.ts';

test('project member candidates include project templates defined on MeshAgents', () => {
  const candidates = projectMemberCandidates({
    acpAgents: [],
    projectMembers: [],
    meshAgents: [
      {
        name: 'codex',
        provider: 'codex',
        productIcon: 'codex',
        command: 'codex',
        enabled: true,
        allowAutopilot: false,
        approvalOwnership: 'provider-owned',
        modelOptions: ['gpt-5.5'],
        modelOptionDisplayNames: { 'gpt-5.5': 'GPT-5.5' },
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
      id: 'mesh-agent-template:codex:reviewer',
      type: 'mesh-agent',
      name: 'codex',
      label: 'Reviewer',
      tag: 'Codex',
      enabled: true,
      provider: 'codex',
      modelOptions: ['gpt-5.5'],
      modelOptionDisplayNames: { 'gpt-5.5': 'GPT-5.5' },
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
