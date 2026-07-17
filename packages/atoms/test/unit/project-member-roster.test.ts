import { expect, test } from 'bun:test';

import { resolveExperienceProjectMembers } from '../../src/workspace-experiences/experience/project-members.ts';

test('active chat projects the session roster instead of newer project templates', () => {
  expect(
    resolveExperienceProjectMembers({
      activeSessionId: 'ses_active',
      memberTemplates: [
        {
          id: 'pmem_opus',
          type: 'external-agent',
          name: 'claude-code',
          displayName: 'Opus',
          settings: { modelId: 'opus' }
        }
      ],
      sessionMembers: [
        {
          id: 'pmem_fable',
          templateId: 'pmem_fable',
          type: 'external-agent',
          name: 'claude-code',
          displayName: 'Fable',
          settings: { modelId: 'fable' }
        }
      ]
    })
  ).toEqual([
    {
      id: 'pmem_fable',
      type: 'external-agent',
      name: 'claude-code',
      templateName: 'claude-code',
      instanceId: 'pmem_fable',
      displayName: 'Fable',
      settings: { modelId: 'fable' }
    }
  ]);
});
