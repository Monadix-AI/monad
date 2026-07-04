import type { NativeCliSessionView } from '@monad/protocol';
import type { Participant } from '../../src/workspace-experiences/project/types.ts';

import { expect, test } from 'bun:test';

import { useChatRoomExperienceStore } from '../../src/workspace-experiences/chat-room/store.ts';
import {
  agentObservationStream,
  groupProjectRailAgents,
  observedRailAgent
} from '../../src/workspace-experiences/chat-room/utils/agent-rail-model.ts';
import { __workplaceProjectMessageTest } from '../../src/workspace-experiences/chat-room/utils/projection.ts';
import { projectMemberParticipants } from '../../src/workspace-experiences/project/project-projection.ts';

const agent = (name: string, presence: Participant['presence']): Participant => ({
  id: `native-cli:${name}`,
  av: name.slice(0, 2).toUpperCase(),
  name,
  kind: 'agent',
  tag: 'CLI',
  presence
});

const nativeCliSession = (overrides: Partial<NativeCliSessionView> = {}): NativeCliSessionView => ({
  id: 'ncli_codex_running',
  transcriptTargetId: 'prj_01KWPROJECT00000000000000',
  agentName: 'pmem_codex_active',
  provider: 'codex',
  productIcon: 'codex',
  workingPath: '/Users/zeke/Projects/monad',
  launchMode: 'app-server',
  approvalOwnership: 'provider-owned',
  runtimeRole: 'managed-project-agent',
  agentRuntimeId: 'ncli_codex_running',
  lastDeliveredSeq: 0,
  lastVisibleSeq: 0,
  state: 'running',
  pid: 12345,
  providerSessionRef: 'codex-thread',
  outputSnapshot: '',
  exitCode: null,
  pendingApprovalCount: 0,
  startedAt: '2026-06-29T10:00:00.000Z',
  updatedAt: '2026-06-29T10:01:00.000Z',
  exitedAt: null,
  ...overrides
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

test('native CLI activity phase treats active runtime work as thinking by default', () => {
  expect(
    __workplaceProjectMessageTest.nativeCliMemberActivityPhase({
      agentName: 'pmem_codex',
      nativeCliSessions: [],
      liveTools: [
        {
          kind: 'tool',
          id: 'tool_native_cli',
          tool: 'native-cli:codex',
          input: { agent: 'pmem_codex' },
          status: 'running',
          seq: '3'
        }
      ]
    })
  ).toBe('thinking');

  expect(
    __workplaceProjectMessageTest.nativeCliMemberActivityPhase({
      agentName: 'pmem_codex_active',
      nativeCliSessions: [
        nativeCliSession({
          outputSnapshot: [
            '{"method":"turn/started","params":{}}',
            '{"method":"item/agentMessage/delta","params":{"delta":"Working"}}'
          ].join('\n')
        })
      ],
      liveTools: []
    })
  ).toBe('thinking');
});

test('native CLI agent-facing project commands map to short activity phases', () => {
  expect(__workplaceProjectMessageTest.nativeCliAgentFacingCommandPhase('Bash: monad project post -')).toBe('speaking');
  expect(__workplaceProjectMessageTest.nativeCliAgentFacingCommandPhase('monad project send "done"')).toBe('speaking');
  expect(__workplaceProjectMessageTest.nativeCliAgentFacingCommandPhase('monad project inbox check')).toBe('reading');
  expect(__workplaceProjectMessageTest.nativeCliAgentFacingCommandPhase('monad inbox read')).toBe('reading');
  expect(__workplaceProjectMessageTest.nativeCliAgentFacingCommandPhase('monad project read --project prj_1')).toBe(
    'reading'
  );
  expect(__workplaceProjectMessageTest.nativeCliAgentFacingCommandPhase('bun test')).toBeUndefined();
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

test('native CLI generating flag tracks snapshot changes for the same session id', () => {
  const generatingOutput = [
    '{"method":"turn/started","params":{}}',
    '{"method":"item/agentMessage/delta","params":{"delta":"Working"}}'
  ].join('\n');
  const idleOutput = [generatingOutput, '{"method":"turn/completed","params":{}}'].join('\n');

  expect(
    __workplaceProjectMessageTest.nativeCliSessionIsGenerating(nativeCliSession({ outputSnapshot: generatingOutput }))
  ).toBe(true);
  expect(
    __workplaceProjectMessageTest.nativeCliSessionIsGenerating(nativeCliSession({ outputSnapshot: idleOutput }))
  ).toBe(false);
  expect(
    __workplaceProjectMessageTest.nativeCliSessionIsGenerating(nativeCliSession({ outputSnapshot: generatingOutput }))
  ).toBe(true);
  expect(
    __workplaceProjectMessageTest.nativeCliSessionIsGenerating(nativeCliSession({ outputSnapshot: generatingOutput }))
  ).toBe(true);
});

test('native CLI presence follows provider turn activity before a project message streams', () => {
  const generatingOutput = [
    '{"method":"turn/started","params":{}}',
    '{"method":"item/agentMessage/delta","params":{"delta":"Working"}}'
  ].join('\n');
  const idleOutput = [
    generatingOutput,
    '{"method":"thread/status/changed","params":{"status":{"type":"idle"}}}',
    '{"method":"turn/completed","params":{}}'
  ].join('\n');

  const generatingSession = nativeCliSession({ outputSnapshot: generatingOutput });
  const idleSession = nativeCliSession({ outputSnapshot: idleOutput });

  expect(__workplaceProjectMessageTest.nativeCliSessionIsGenerating(generatingSession)).toBe(true);
  expect(
    __workplaceProjectMessageTest.nativeCliMemberPresence({
      agentName: 'pmem_codex_active',
      enabled: true,
      nativeCliSessions: [generatingSession],
      liveTools: []
    })
  ).toBe('working');

  expect(__workplaceProjectMessageTest.nativeCliSessionIsGenerating(idleSession)).toBe(false);
  expect(
    __workplaceProjectMessageTest.nativeCliMemberPresence({
      agentName: 'pmem_codex_active',
      enabled: true,
      nativeCliSessions: [idleSession],
      liveTools: []
    })
  ).toBe('online');
});

test('native CLI presence returns to online after Claude Code result', () => {
  const generatingOutput = [
    JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Working' }
      }
    })
  ].join('\n');
  const idleOutput = [
    generatingOutput,
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn' })
  ].join('\n');

  const generatingSession = nativeCliSession({
    provider: 'claude-code',
    productIcon: 'claude-code',
    outputSnapshot: generatingOutput
  });
  const idleSession = nativeCliSession({
    provider: 'claude-code',
    productIcon: 'claude-code',
    outputSnapshot: idleOutput
  });

  expect(__workplaceProjectMessageTest.nativeCliSessionIsGenerating(generatingSession)).toBe(true);
  expect(__workplaceProjectMessageTest.nativeCliSessionIsGenerating(idleSession)).toBe(false);
  expect(
    __workplaceProjectMessageTest.nativeCliMemberPresence({
      agentName: 'pmem_codex_active',
      enabled: true,
      nativeCliSessions: [idleSession],
      liveTools: []
    })
  ).toBe('online');
});

test('project rail includes explicitly invited Monad members', () => {
  expect(
    projectMemberParticipants([{ ...agent('monad', 'online'), id: 'monad', tag: 'AI' }, agent('codex', 'idle')]).map(
      (item) => item.name
    )
  ).toEqual(['monad', 'codex']);
});

test('chatroom experience store opens the same observation view from follow and agent rows', () => {
  useChatRoomExperienceStore.getState().closeRailObservation();

  useChatRoomExperienceStore.getState().followNativeCliSession('project-1', 'ncli:codex');
  expect(useChatRoomExperienceStore.getState().railObservation).toEqual({
    projectId: 'project-1',
    nativeCliSessionId: 'ncli:codex'
  });

  useChatRoomExperienceStore.getState().observeProjectAgent('project-1', {
    agentId: 'native-cli:codex',
    agentName: 'codex'
  });
  expect(useChatRoomExperienceStore.getState().railObservation).toEqual({
    projectId: 'project-1',
    agentId: 'native-cli:codex',
    agentName: 'codex'
  });
});

test('agent observation selects the currently running native CLI stream by instance id', () => {
  const streams = [
    {
      id: 'ncli_old',
      agentName: 'pmem_codex_one',
      provider: 'codex',
      tag: 'Codex',
      status: 'ok' as const,
      output: '',
      items: []
    },
    {
      id: 'ncli_running',
      agentName: 'pmem_codex_one',
      provider: 'codex',
      tag: 'Codex',
      status: 'running' as const,
      output: 'thinking',
      items: [{ id: 'item_1', role: 'agent' as const, text: 'Thinking', source: 'codex-app-server' as const }]
    },
    {
      id: 'ncli_other_project',
      agentName: 'codex',
      provider: 'codex',
      tag: 'Codex',
      status: 'running' as const,
      output: 'wrong project',
      items: []
    }
  ];

  expect(agentObservationStream({ agentId: 'pmem_codex_one', agentName: 'Codex' }, streams)?.id).toBe('ncli_running');
  expect(agentObservationStream({ nativeCliSessionId: 'ncli_old' }, streams)?.id).toBe('ncli_old');
});

test('native CLI session observation reuses the project member identity', () => {
  const railAgent = {
    ...agent('Lily', 'online'),
    id: 'pmem_codex_1a6c1dcc142',
    avatarUrl: '/api/avatar-cache/lily.svg?seed=Lily',
    icon: 'codex'
  } as Participant;
  const stream = {
    id: 'ncli_codex',
    agentName: 'pmem_codex_1a6c1dcc142',
    provider: 'codex',
    tag: 'Codex',
    status: 'ok' as const,
    output: '',
    items: []
  };

  expect(observedRailAgent({ nativeCliSessionId: 'ncli_codex' }, stream, [railAgent])).toBe(railAgent);
});
