import type { ExperienceStateStore, ProjectSessionOperations, WorkspaceExperiencePermission } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import { AtomPackRegistry } from '#/handlers/atom-pack/atom-pack-registry.ts';
import { createWorkspaceExperienceApiContext } from '#/handlers/atom-pack/experience-capabilities.ts';

const emptyState: ExperienceStateStore = {
  get: async () => null,
  list: async () => [],
  compareAndSwap: async () => true
};

function sessions(overrides: Partial<ProjectSessionOperations> = {}): ProjectSessionOperations {
  return {
    list: async () => [],
    create: async () => ({ id: 'ses_a' }),
    sendMessage: async () => {},
    listMessages: async () => ({ items: [], nextCursor: null }),
    listObservations: async () => ({ items: [], nextCursor: null }),
    runTurn: async () => ({ runId: 'run_a' }),
    pause: async () => {},
    cancel: async () => {},
    listPendingApprovals: async () => [],
    resolveApproval: async () => {},
    ...overrides
  };
}

function context(permissions: WorkspaceExperiencePermission[]) {
  return createWorkspaceExperienceApiContext({
    atomPackId: 'pack-a',
    principalId: 'prn_a',
    permissions,
    deps: {
      state: { forPack: () => emptyState },
      projectSessions: { forPrincipal: () => sessions() },
      workerScheduler: {
        forPack: () => ({ schedule: async () => {}, cancel: async () => {} })
      }
    }
  });
}

test('workspace Experience context derives the trusted pack and principal', () => {
  const result = context(['experience.state']);

  expect(result.atomPackId).toBe('pack-a');
  expect(result.principalId).toBe('prn_a');
});

test('an undeclared project observation permission fails before adapter access', async () => {
  const result = context(['experience.state']);

  await expect(result.projectSessions.listObservations('ses_a')).rejects.toThrow('project.observations.read');
});

test('a declared observation permission reaches the principal-scoped adapter', async () => {
  const result = context(['project.observations.read']);

  expect(await result.projectSessions.listObservations('ses_a')).toEqual({ items: [], nextCursor: null });
});

test('registered API routes retain their trusted pack owner and manifest permissions', () => {
  const registry = new AtomPackRegistry();
  registry.registerWorkspaceExperience(
    {
      id: 'board',
      title: 'Board',
      entry: { type: 'web-component', module: './board.js', tagName: 'monad-board' }
    },
    'pack-a'
  );
  registry.registerWorkspaceExperienceApi(
    {
      experienceId: 'board',
      routes: [{ method: 'GET', path: '/whoami', handle: async () => Response.json({ ok: true }) }]
    },
    'pack-a',
    ['experience.state']
  );

  expect(registry.getWorkspaceExperienceApiRoute('board', 'GET', '/whoami')).toMatchObject({
    atomPackId: 'pack-a',
    permissions: ['experience.state']
  });
});

test('session idempotency keys are namespaced by the trusted pack identity', async () => {
  let received = '';
  const result = createWorkspaceExperienceApiContext({
    atomPackId: 'pack-a',
    principalId: 'prn_a',
    permissions: ['project.sessions.create'],
    deps: {
      state: { forPack: () => emptyState },
      projectSessions: {
        forPrincipal: () =>
          sessions({
            create: async (_projectId, input) => {
              received = input.idempotencyKey;
              return { id: 'ses_a' };
            }
          })
      },
      workerScheduler: { forPack: () => ({ schedule: async () => {}, cancel: async () => {} }) }
    }
  });

  await result.projectSessions.create('prj_a', { title: 'A', idempotencyKey: 'request-a' });
  expect(received).toBe('pack-a:request-a');
});
