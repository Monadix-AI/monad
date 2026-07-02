import type { Participant } from '../../features/workplace/types.ts';

import { expect, test } from 'bun:test';

import { groupProjectRailAgents } from '../../features/workplace/activity/AgentTasksRail.tsx';
import { __workplaceProjectMessageTest, projectMemberParticipants } from '../../features/workplace/use-project.ts';
import { useWorkplaceUiStore } from '../../features/workplace/workplace-ui-store.ts';

const agent = (name: string, presence: Participant['presence']): Participant => ({
  id: `native-cli:${name}`,
  av: name.slice(0, 2).toUpperCase(),
  name,
  kind: 'agent',
  tag: 'CLI',
  presence
});

test('project rail groups only actively generating agents as active', () => {
  const groups = groupProjectRailAgents([
    agent('codex', 'idle'),
    agent('claude', 'working'),
    agent('gemini', 'failed'),
    agent('qwen', 'online'),
    agent('needs-auth', 'needs-login')
  ]);

  expect(groups.active.map((item) => item.name)).toEqual(['claude']);
  expect(groups.standBy.map((item) => item.name)).toEqual(['codex', 'gemini', 'qwen', 'needs-auth']);
});

test('native CLI stopped sessions remain available when the template is enabled', () => {
  const presence = __workplaceProjectMessageTest.nativeCliMemberPresence({
    agentName: 'pmem_codex_available',
    enabled: true,
    nativeCliSessions: [
      {
        id: 'ncli_stopped',
        transcriptTargetId: 'prj_01KWPROJECT00000000000000',
        agentName: 'pmem_codex_available',
        provider: 'codex',
        productIcon: 'codex',
        workingPath: '/Users/zeke/Projects/monad',
        launchMode: 'app-server',
        approvalOwnership: 'provider-owned',
        runtimeRole: 'managed-project-agent',
        agentRuntimeId: 'ncli_stopped',
        lastDeliveredSeq: 0,
        lastVisibleSeq: 0,
        state: 'stopped',
        pid: null,
        providerSessionRef: 'codex-thread',
        outputSnapshot: '',
        exitCode: 0,
        pendingApprovalCount: 0,
        startedAt: '2026-06-29T10:00:00.000Z',
        updatedAt: '2026-06-29T10:01:00.000Z',
        exitedAt: '2026-06-29T10:01:00.000Z'
      }
    ],
    liveTools: []
  });

  expect(presence).toBe('online');
});

test('project rail includes explicitly invited Monad members', () => {
  expect(
    projectMemberParticipants([{ ...agent('monad', 'online'), id: 'monad', tag: 'AI' }, agent('codex', 'idle')]).map(
      (item) => item.name
    )
  ).toEqual(['monad', 'codex']);
});

test('workplace UI store opens the same observation view from follow and agent rows', () => {
  useWorkplaceUiStore.getState().closeRailObservation();

  useWorkplaceUiStore.getState().followNativeCliSession('project-1', 'ncli:codex');
  expect(useWorkplaceUiStore.getState().railObservation).toEqual({
    projectId: 'project-1',
    nativeCliSessionId: 'ncli:codex'
  });

  useWorkplaceUiStore.getState().observeProjectAgent('project-1', { agentId: 'native-cli:codex', agentName: 'codex' });
  expect(useWorkplaceUiStore.getState().railObservation).toEqual({
    projectId: 'project-1',
    agentId: 'native-cli:codex',
    agentName: 'codex'
  });
});

test('workplace UI store owns project settings panel state', () => {
  useWorkplaceUiStore.getState().closeProjectSettings();

  useWorkplaceUiStore.getState().openProjectSettings('project-1');
  expect(useWorkplaceUiStore.getState().projectSettings).toEqual({
    projectId: 'project-1'
  });

  useWorkplaceUiStore.getState().closeProjectSettings();
  expect(useWorkplaceUiStore.getState().projectSettings).toBeNull();
});

test('workplace UI store keeps project settings and member settings separate', () => {
  useWorkplaceUiStore.getState().closeProjectSettings();
  useWorkplaceUiStore.getState().closeProjectMemberSettings();

  useWorkplaceUiStore.getState().openProjectMemberSettings('project-1', 'native-cli:codex');
  expect(useWorkplaceUiStore.getState().projectSettings).toBeNull();
  expect(useWorkplaceUiStore.getState().projectMemberSettings).toEqual({
    projectId: 'project-1',
    memberId: 'native-cli:codex'
  });

  useWorkplaceUiStore.getState().closeProjectMemberSettings();
  expect(useWorkplaceUiStore.getState().projectMemberSettings).toBeNull();
});

test('workplace UI store owns native CLI auth session state', () => {
  useWorkplaceUiStore.getState().clearNativeCliAuthSession();

  useWorkplaceUiStore.getState().setStartingNativeCliAuthAgent('codex');
  expect(useWorkplaceUiStore.getState().startingNativeCliAuthAgent).toBe('codex');

  useWorkplaceUiStore.getState().setNativeCliAuthSession({ id: 'auth-1', agentName: 'codex' });
  expect(useWorkplaceUiStore.getState().nativeCliAuthSession).toEqual({ id: 'auth-1', agentName: 'codex' });

  useWorkplaceUiStore.getState().clearNativeCliAuthSession();
  expect(useWorkplaceUiStore.getState().nativeCliAuthSession).toBeNull();
});
