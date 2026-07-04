import type { NativeCliAgentView, NativeCliAuthSessionView } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { connectNativeCliAgent } from '../../features/studio/third-party-agents/native-cli-connect-agent';

const agent: NativeCliAgentView = {
  name: 'qwen',
  provider: 'qwen',
  command: 'qwen',
  args: [],
  modelOptions: [],
  enabled: true,
  defaultLaunchMode: 'pty',
  allowDangerousMode: false,
  approvalOwnership: 'provider-owned'
};

const authSession = (authState: NativeCliAuthSessionView['authState']): NativeCliAuthSessionView => ({
  id: 'ncliauth_01KWAUTH000000000000000',
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

test('native CLI connect removes the temporary agent when auth is not authenticated', async () => {
  const saved: NativeCliAgentView[] = [];
  const removed: string[] = [];

  const result = await connectNativeCliAgent(agent, {
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

test('native CLI connect saves an agent after authenticated auth', async () => {
  const saved: NativeCliAgentView[] = [];
  const removed: string[] = [];

  const result = await connectNativeCliAgent(agent, {
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
  expect(removed).toEqual([]);
});

test('native CLI connect removes the temporary agent when auth start fails', async () => {
  const saved: NativeCliAgentView[] = [];
  const removed: string[] = [];

  await expect(
    connectNativeCliAgent(agent, {
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
