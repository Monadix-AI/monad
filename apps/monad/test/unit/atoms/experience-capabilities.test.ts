import type { SessionMemberBinding } from '@monad/protocol';
import type { ExperienceStateStore, ProjectSessionOperations, WorkplaceExperiencePermission } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import { AtomPackRegistry } from '#/handlers/atom-pack/atom-pack-registry.ts';
import { createWorkplaceExperienceApiContext } from '#/handlers/atom-pack/experience-capabilities.ts';

const stubMemberBinding: SessionMemberBinding = {
  member: {
    id: 'pmem_test00000001',
    projectId: 'prj_test000000001',
    profileId: 'tmpl_a',
    type: 'mesh-agent',
    displayName: 'Codex',
    customPrompt: null,
    launchOverrides: {},
    workingDirectoryOverride: null,
    lifecycle: 'enabled',
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z'
  },
  binding: {
    sessionId: 'ses_test000000001',
    projectMemberId: 'pmem_test00000001',
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    currentNativeRuntimeSessionId: null,
    lifecycle: 'active',
    lastHealth: null,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z'
  }
};

const emptyState: ExperienceStateStore = {
  get: async () => null,
  list: async () => [],
  compareAndSwap: async () => true,
  compareAndDelete: async () => true
};

function sessions(overrides: Partial<ProjectSessionOperations> = {}): ProjectSessionOperations {
  return {
    list: async () => [],
    create: async () => ({ id: 'ses_a' }),
    sendMessage: async () => {},
    listMessages: async () => ({ items: [], nextCursor: null }),
    listArtifacts: async () => [],
    listObservations: async () => ({ items: [], nextCursor: null }),
    runTurn: async () => ({ runId: 'run_a' }),
    getRun: async () => null,
    pause: async () => {},
    cancel: async () => {},
    listPendingApprovals: async () => [],
    resolveApproval: async () => {},
    ...overrides
  };
}

function context(
  permissions: WorkplaceExperiencePermission[],
  overrides: {
    removeSessionMember?: (sessionId: string, memberId: string) => Promise<void>;
    requestInteraction?: () => Promise<
      { status: 'submitted'; values: { confirmed: true } } | { status: 'cancelled'; reason: 'unavailable' }
    >;
  } = {}
) {
  const futureMemberDeps = {
    projectMembers: {
      operations: () => ({
        listTemplates: async () => [{ id: 'tmpl_a', type: 'mesh-agent' as const, name: 'codex', displayName: 'Codex' }],
        listSessionMembers: async () => [],
        inviteSessionMember: async () => stubMemberBinding,
        removeSessionMember: overrides.removeSessionMember ?? (async () => {})
      })
    }
  };
  return createWorkplaceExperienceApiContext({
    atomPackId: 'pack-a',
    experienceId: 'board',
    permissions,
    deps: {
      ...futureMemberDeps,
      state: { forPack: () => emptyState },
      projectSessions: { operations: () => sessions() },
      interactions: {
        request:
          overrides.requestInteraction ??
          (async () => ({ status: 'cancelled' as const, reason: 'unavailable' as const }))
      },
      workerScheduler: {
        forExperience: () => ({ schedule: async () => {}, cancel: async () => {} })
      }
    }
  });
}

test('workplace experience context derives the trusted pack and experience', () => {
  const result = context(['experience.state']);

  expect(result.atomPackId).toBe('pack-a');
  expect(result.experienceId).toBe('board');
});

test('an undeclared project observation permission fails before adapter access', async () => {
  const result = context(['experience.state']);

  await expect(result.projectSessions.listObservations('ses_a')).rejects.toThrow('project.observations.read');
});

test('a declared observation permission reaches the project session adapter', async () => {
  const result = context(['project.observations.read']);

  expect(await result.projectSessions.listObservations('ses_a')).toEqual({ items: [], nextCursor: null });
});

test('project artifacts use the project session read permission', async () => {
  const denied = context(['experience.state']);
  const allowed = context(['project.sessions.read']);

  await expect(denied.projectSessions.listArtifacts?.('ses_a')).rejects.toThrow('project.sessions.read');
  expect(await allowed.projectSessions.listArtifacts?.('ses_a')).toEqual([]);
});

test('project member capabilities enforce read and invite permissions independently', async () => {
  const readOnly = context(['project.members.read' as WorkplaceExperiencePermission]) as unknown as {
    projectMembers?: {
      listTemplates(projectId: string): Promise<unknown[]>;
      inviteSessionMember(sessionId: string, templateId: string): Promise<unknown>;
    };
  };
  const templates = (await readOnly.projectMembers?.listTemplates('prj_a')) ?? [];

  expect(templates).toEqual([{ id: 'tmpl_a', type: 'mesh-agent', name: 'codex', displayName: 'Codex' }]);
  await expect(readOnly.projectMembers?.inviteSessionMember('ses_a', 'tmpl_a')).rejects.toThrow(
    'project.members.invite'
  );

  const inviter = context(['project.members.invite' as WorkplaceExperiencePermission]) as unknown as {
    projectMembers?: {
      listTemplates(projectId: string): Promise<unknown[]>;
      inviteSessionMember(sessionId: string, templateId: string): Promise<unknown>;
    };
  };
  expect(await inviter.projectMembers?.inviteSessionMember('ses_a', 'tmpl_a')).toEqual(stubMemberBinding);
  await expect(inviter.projectMembers?.listTemplates('prj_a')).rejects.toThrow('project.members.read');
});

test('project member removal requires its own permission and delegates exact session identity', async () => {
  const calls: Array<{ memberId: string; sessionId: string }> = [];
  const denied = context([]);

  await expect(denied.projectMembers.removeSessionMember('ses_a', 'tmpl_a')).rejects.toThrow('project.members.remove');

  const allowed = context(['project.members.remove'], {
    removeSessionMember: async (sessionId, memberId) => {
      calls.push({ sessionId, memberId });
    }
  });
  await allowed.projectMembers.removeSessionMember('ses_a', 'tmpl_a');

  expect(calls).toEqual([{ sessionId: 'ses_a', memberId: 'tmpl_a' }]);
});

test('workplace experience requests a foreground host interaction under its trusted identity', async () => {
  const requests: unknown[] = [];
  const result = context([], {
    requestInteraction: async (...args: unknown[]) => {
      requests.push(args);
      return { status: 'submitted', values: { confirmed: true } };
    }
  });

  expect(await result.requestInteraction({ type: 'confirm', title: 'Remove member?', confirmLabel: 'Remove' })).toEqual(
    { status: 'submitted', values: { confirmed: true } }
  );
  expect(requests).toEqual([
    [
      { kind: 'atom-pack', packId: 'pack-a', atomId: 'board' },
      { type: 'confirm', title: 'Remove member?', confirmLabel: 'Remove' },
      { mode: 'foreground' }
    ]
  ]);
});

test('registered API routes retain their trusted pack owner and manifest permissions', () => {
  const registry = new AtomPackRegistry();
  registry.registerWorkplaceExperience(
    {
      id: 'board',
      title: 'Board',
      entry: { type: 'web-component', module: './board.js', tagName: 'monad-board' }
    },
    'pack-a'
  );
  registry.registerWorkplaceExperienceApi(
    {
      experienceId: 'board',
      routes: [{ method: 'GET', path: '/whoami', handle: async () => Response.json({ ok: true }) }]
    },
    'pack-a',
    ['experience.state']
  );

  expect(registry.getWorkplaceExperienceApiRoute('board', 'GET', '/whoami')).toMatchObject({
    atomPackId: 'pack-a',
    permissions: ['experience.state']
  });
});

test('session idempotency keys are namespaced by the trusted pack identity', async () => {
  let received = '';
  const result = createWorkplaceExperienceApiContext({
    atomPackId: 'pack-a',
    experienceId: 'board',
    permissions: ['project.sessions.create'],
    deps: {
      state: { forPack: () => emptyState },
      projectSessions: {
        operations: () =>
          sessions({
            create: async (_projectId, input) => {
              received = input.idempotencyKey;
              return { id: 'ses_a' };
            }
          })
      },
      projectMembers: {
        operations: () => ({
          listTemplates: async () => [],
          listSessionMembers: async () => [],
          inviteSessionMember: async () => stubMemberBinding,
          removeSessionMember: async () => {}
        })
      },
      interactions: {
        request: async () => ({ status: 'cancelled', reason: 'unavailable' })
      },
      workerScheduler: { forExperience: () => ({ schedule: async () => {}, cancel: async () => {} }) }
    }
  });

  await result.projectSessions.create('prj_a', { title: 'A', idempotencyKey: 'request-a' });
  expect(received).toBe('pack-a:request-a');
});
