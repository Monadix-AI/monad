import type { MeshAgentView } from '@monad/protocol';
import type { createSessionModule } from '#/handlers/session/index.ts';
import type { Store } from '#/store/db/index.ts';

import { expect, test } from 'bun:test';
import { entityAvatarUrl } from '@monad/protocol';

import { createProjectMemberOperations } from '#/atoms/experience-project-members.ts';

test('project member templates include daemon-derived avatar and provider presentation', async () => {
  const store = {
    getWorkplaceProject: () => ({
      memberTemplates: [
        {
          id: 'tmpl_sol',
          type: 'mesh-agent' as const,
          name: 'codex',
          displayName: 'GPT 5.6 Sol'
        }
      ]
    })
  } as unknown as Store;
  const meshAgent = {
    name: 'codex',
    provider: 'codex',
    productIcon: 'codex'
  } as MeshAgentView;
  const operations = createProjectMemberOperations({
    avatarStyle: () => 'notionists',
    meshAgents: () => [meshAgent],
    sessions: {} as ReturnType<typeof createSessionModule>,
    store
  });

  expect(await operations.listTemplates('prj_a')).toEqual([
    {
      id: 'tmpl_sol',
      type: 'mesh-agent',
      name: 'codex',
      displayName: 'GPT 5.6 Sol',
      presentation: {
        avatarUrl: entityAvatarUrl('mesh-agent|project:prj_a|name:GPT 5.6 Sol', 'notionists'),
        icon: 'codex',
        provider: 'codex'
      }
    }
  ]);
});

test('Monad templates use the same MeshAgent presentation path as every provider', async () => {
  const store = {
    getWorkplaceProject: () => ({
      memberTemplates: [
        {
          id: 'monad:agt_eAmWnO0FDkBJ',
          type: 'mesh-agent' as const,
          name: 'monad--agt_eAmWnO0FDkBJ',
          settings: { managedProjectAgent: true }
        }
      ]
    })
  } as unknown as Store;
  const meshAgent = {
    name: 'monad--agt_eAmWnO0FDkBJ',
    displayName: 'Default Dev Agent',
    provider: 'monad',
    productIcon: 'monad'
  } as MeshAgentView;
  const operations = createProjectMemberOperations({
    avatarStyle: () => 'notionists',
    meshAgents: () => [meshAgent],
    sessions: {} as ReturnType<typeof createSessionModule>,
    store
  });

  expect(await operations.listTemplates('prj_test')).toEqual([
    {
      id: 'monad:agt_eAmWnO0FDkBJ',
      type: 'mesh-agent',
      name: 'monad--agt_eAmWnO0FDkBJ',
      displayName: 'Default Dev Agent',
      settings: { managedProjectAgent: true },
      presentation: {
        avatarUrl: entityAvatarUrl('mesh-agent|project:prj_test|name:Default Dev Agent', 'notionists'),
        icon: 'monad',
        provider: 'monad'
      }
    }
  ]);
});
