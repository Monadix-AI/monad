import type { MeshAgentConfig } from '@monad/environment';
import type { MeshSessionView } from '@monad/protocol';
import type { Store } from '#/store/db/index.ts';

import { expect, test } from 'bun:test';

import { createNativeAgentSessionMembersService } from '#/services/native-agent/session-members.ts';

const configs = ['active', 'sleeping', 'logged-out', 'stale', 'broken'].map(
  (name) => ({ name, provider: 'codex', command: 'codex', enabled: true }) as MeshAgentConfig
);

function member(name: string, displayName: string) {
  return {
    sessionId: 'ses_availability000',
    memberId: name,
    templateId: null,
    type: 'mesh-agent',
    meshSessionId: null,
    data: { name, displayName, settings: { managedProjectAgent: true } },
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z'
  };
}

function memberInstance(instanceId: string, templateName: string, displayName: string) {
  return {
    ...member(instanceId, displayName),
    data: {
      name: templateName,
      instanceId,
      displayName,
      settings: { managedProjectAgent: true }
    }
  };
}

test('session member availability follows delivery readiness instead of CLI process presence', async () => {
  const store = {
    getSession: () => ({ id: 'ses_availability000', cwd: '/tmp/project' }),
    listSessionMembers: () => [
      member('active', 'Active'),
      member('sleeping', 'Sleeping'),
      member('logged-out', 'Logged out'),
      member('stale', 'Stale'),
      member('broken', 'Broken'),
      member('unconfigured', 'Unconfigured')
    ]
  } as unknown as Store;
  const suspended = {
    agentName: 'active',
    runtimeRole: 'managed-project-agent',
    lifecycle: { state: 'active' },
    activity: {
      state: 'suspended',
      pid: null,
      suspendedAt: '2026-07-20T00:00:00.000Z',
      queuedTurnCount: 0
    },
    capabilities: { input: true }
  } as unknown as MeshSessionView;
  const stale = {
    agentName: 'stale',
    runtimeRole: 'managed-project-agent',
    lifecycle: { state: 'active' },
    capabilities: { input: false }
  } as unknown as MeshSessionView;
  const service = createNativeAgentSessionMembersService({
    store,
    meshAgents: () => configs,
    meshAgentHost: {
      list: () => ({ sessions: [suspended, stale] }),
      preflight: async (name) => {
        if (name === 'sleeping') {
          return {
            state: 'ready',
            agentName: name,
            provider: 'codex',
            checkedAt: '2026-07-20T00:00:00.000Z'
          };
        }
        if (name === 'logged-out') {
          return {
            state: 'not_authenticated',
            agentName: name,
            provider: 'codex',
            checkedAt: '2026-07-20T00:00:00.000Z',
            action: 'reconnect_in_studio',
            reason: 'login required'
          };
        }
        throw new Error('probe failed');
      }
    }
  });

  expect(await service.list('ses_availability000', 'sender')).toEqual({
    members: [
      { id: 'active', displayName: 'Active', status: 'online' },
      { id: 'sleeping', displayName: 'Sleeping', status: 'online' },
      { id: 'logged-out', displayName: 'Logged out', status: 'offline' },
      { id: 'stale', displayName: 'Stale', status: 'offline' },
      { id: 'broken', displayName: 'Broken', status: 'offline' },
      { id: 'unconfigured', displayName: 'Unconfigured', status: 'offline' }
    ]
  });
});

test('session member availability excludes the requesting agent from delivery targets', async () => {
  const store = {
    getSession: () => ({ id: 'ses_availability000', cwd: '/tmp/project' }),
    listSessionMembers: () => [member('active', 'Active'), member('sleeping', 'Sleeping')]
  } as unknown as Store;
  const service = createNativeAgentSessionMembersService({
    store,
    meshAgents: () => configs,
    meshAgentHost: {
      list: () => ({
        sessions: [
          {
            agentName: 'active',
            runtimeRole: 'managed-project-agent',
            lifecycle: { state: 'active' },
            capabilities: { input: true }
          } as unknown as MeshSessionView
        ]
      }),
      preflight: async (name) => ({
        state: 'ready',
        agentName: name,
        provider: 'codex',
        checkedAt: '2026-07-20T00:00:00.000Z'
      })
    }
  });

  expect(await service.list('ses_availability000', 'active')).toEqual({
    members: [{ id: 'sleeping', displayName: 'Sleeping', status: 'online' }]
  });
});

test('session member availability probes a shared template only once', async () => {
  const preflightNames: string[] = [];
  const store = {
    getSession: () => ({ id: 'ses_availability000', cwd: '/tmp/project' }),
    listSessionMembers: () => [
      memberInstance('reviewer-a', 'sleeping', 'Reviewer A'),
      memberInstance('reviewer-b', 'sleeping', 'Reviewer B')
    ]
  } as unknown as Store;
  const service = createNativeAgentSessionMembersService({
    store,
    meshAgents: () => configs,
    meshAgentHost: {
      list: () => ({ sessions: [] }),
      preflight: async (name) => {
        preflightNames.push(name);
        return {
          state: 'ready',
          agentName: name,
          provider: 'codex',
          checkedAt: '2026-07-20T00:00:00.000Z'
        };
      }
    }
  });

  expect(await service.list('ses_availability000', 'sender')).toEqual({
    members: [
      { id: 'reviewer-a', displayName: 'Reviewer A', status: 'online' },
      { id: 'reviewer-b', displayName: 'Reviewer B', status: 'online' }
    ]
  });
  expect(preflightNames).toEqual(['sleeping']);
});
