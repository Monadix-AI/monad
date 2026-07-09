import type { ExternalAgentAuthSessionView, ExternalAgentView } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { connectExternalAgent } from '../../src/features/studio/third-party-agents/external-agent-connect-agent';

const agent: ExternalAgentView = {
  name: 'qwen',
  provider: 'qwen',
  command: 'qwen',
  args: [],
  modelOptions: [],
  enabled: true,
  defaultLaunchMode: 'pty',
  allowAutopilot: false,
  approvalOwnership: 'provider-owned'
};

const authSession = (authState: ExternalAgentAuthSessionView['authState']): ExternalAgentAuthSessionView => ({
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

test('external agent connect removes the temporary agent when auth is not authenticated', async () => {
  const saved: ExternalAgentView[] = [];
  const removed: string[] = [];

  const result = await connectExternalAgent(agent, {
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

test('external agent connect saves an agent after authenticated auth', async () => {
  const saved: ExternalAgentView[] = [];
  const removed: string[] = [];

  const result = await connectExternalAgent(agent, {
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

test('external agent connect removes the temporary agent when auth start fails', async () => {
  const saved: ExternalAgentView[] = [];
  const removed: string[] = [];

  await expect(
    connectExternalAgent(agent, {
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
