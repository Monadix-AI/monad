import type { MeshAgentAuthSessionView, MeshAgentView } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { connectMeshAgent } from '../../src/features/studio/third-party-agents/mesh-agent-connect-agent';

const agent: MeshAgentView = {
  name: 'qwen',
  provider: 'qwen',
  command: 'qwen',
  args: [],
  modelOptions: [],
  enabled: true,
  allowAutopilot: false,
  approvalOwnership: 'provider-owned'
};

const authSession = (authState: MeshAgentAuthSessionView['authState']): MeshAgentAuthSessionView => ({
  id: 'ncliauth_01KWAUTHGSVp',
  controlToken: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  agentName: agent.name,
  provider: agent.provider,
  approvalOwnership: 'provider-owned',
  authState,
  state: 'exited',
  pid: 0,
  outputSnapshot: '',
  exitCode: authState === 'authenticated' ? 0 : 1,
  startedAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  exitedAt: '2026-07-01T00:00:00.000Z'
});

test('MeshAgent connect removes the temporary agent when auth is not authenticated', async () => {
  const saved: MeshAgentView[] = [];
  const removed: string[] = [];

  const result = await connectMeshAgent(agent, {
    saveAgent: async (next) => {
      saved.push(next);
    },
    removeAgent: async (name) => {
      removed.push(name);
    },
    startAuth: async () => authSession('unauthenticated')
  });

  expect(result.persisted).toBe(false);
  expect(saved).toEqual([agent]);
  expect(removed).toEqual([agent.name]);
});

test('MeshAgent connect saves an agent after authenticated auth', async () => {
  const saved: MeshAgentView[] = [];
  const removed: string[] = [];

  const result = await connectMeshAgent(agent, {
    saveAgent: async (next) => {
      saved.push(next);
    },
    removeAgent: async (name) => {
      removed.push(name);
    },
    startAuth: async () => authSession('authenticated')
  });

  expect(result.persisted).toBe(true);
  expect(saved).toEqual([agent]);
});

test('MeshAgent connect removes the temporary agent when auth start fails', async () => {
  const saved: MeshAgentView[] = [];
  const removed: string[] = [];

  await expect(
    connectMeshAgent(agent, {
      saveAgent: async (next) => {
        saved.push(next);
      },
      removeAgent: async (name) => {
        removed.push(name);
      },
      startAuth: async () => {
        throw new Error('auth start failed');
      }
    })
  ).rejects.toThrow('auth start failed');

  expect(saved).toEqual([agent]);
  expect(removed).toEqual([agent.name]);
});
