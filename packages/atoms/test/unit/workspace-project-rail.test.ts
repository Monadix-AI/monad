import type { AgentObservationEvent, MeshAgentView, MeshSessionView } from '@monad/protocol';
import type { AgentObservationCard } from '../../src/agent-adapters/observation-cards.ts';
import type { Participant } from '../../src/workspace-experiences/experience/types.ts';

import { expect, test } from 'bun:test';
import '../../src/index.ts';

import { useChatRoomExperienceStore } from '../../src/workspace-experiences/chat-room/store.ts';
import {
  agentObservationStream,
  groupProjectRailAgents,
  isActiveRailAgent,
  observedRailAgent,
  railAgentActivityPhase,
  shouldAnimateRailAgent,
  sortedProjectRailAgents
} from '../../src/workspace-experiences/chat-room/utils/agent-rail-model.ts';
import { __workplaceProjectMessageTest } from '../../src/workspace-experiences/chat-room/utils/projection.ts';
import {
  meshAgentMemberActivityPhase,
  meshAgentMemberPresence
} from '../../src/workspace-experiences/experience/mesh-agent-presence.ts';
import { projectMemberParticipants } from '../../src/workspace-experiences/experience/project-projection.ts';

const agent = (name: string, presence: Participant['presence']): Participant => ({
  id: `mesh-agent:${name}`,
  av: name.slice(0, 2).toUpperCase(),
  name,
  kind: 'agent',
  tag: 'CLI',
  presence
});

function messageCard(id: string, text: string): AgentObservationCard {
  return {
    id,
    kind: 'message',
    streaming: false,
    payload: { text },
    provenance: { contractEvents: [{ id, text }] }
  };
}

type LegacySessionOverrides = Partial<MeshSessionView> & {
  state?: 'starting' | 'running' | 'exited' | 'failed' | 'stopped';
  pid?: number | null;
  outputSnapshot?: string;
  exitCode?: number | null;
  exitedAt?: string | null;
};

const meshSession = (overrides: LegacySessionOverrides = {}): MeshSessionView => {
  const { state, pid, outputSnapshot, exitCode, exitedAt, ...current } = overrides;
  void outputSnapshot;
  const at = exitedAt ?? '2026-06-29T10:01:00.000Z';
  return {
    id: 'mesh_codexrunning',
    sessionId: 'ses_01KWPROJ2tDh',
    agentName: 'pmem_codex_active',
    provider: 'codex',
    productIcon: 'codex',
    workingPath: '/Users/test/Projects/monad',
    approvalOwnership: 'provider-owned',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: 'mesh_codexrunning',
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    lifecycle:
      state && state !== 'running' && state !== 'starting'
        ? { state: 'terminal', termination: { kind: state, at, ...(exitCode != null ? { exitCode } : {}) } }
        : { state: state === 'starting' ? 'starting' : 'active' },
    activity:
      state === 'starting'
        ? { state: 'starting', pid: pid ?? null, queuedTurnCount: 0 }
        : { state: 'idle', pid: null, queuedTurnCount: 0 },
    connection: { state: 'connected' },
    capabilities: {
      input: true,
      steer: true,
      interrupt: true,
      approvalResolution: true,
      providerSessionContinuation: true,
      runtimeRestoration: true,
      sessionReopen: true
    },
    providerSessionRef: 'codex-thread',
    pendingApprovalCount: 0,
    startedAt: '2026-06-29T10:00:00.000Z',
    updatedAt: '2026-06-29T10:01:00.000Z',
    ...current
  };
};

const claudeSession = (records: Record<string, unknown>[]): MeshSessionView =>
  meshSession({
    id: 'mesh_claude000000',
    agentName: 'pmem_claude',
    provider: 'claude-code',
    productIcon: 'claude-code',
    outputSnapshot: records.map((record) => JSON.stringify(record)).join('\n')
  });

const claudeAssistant = (part: Record<string, unknown>) => ({ type: 'assistant', message: { content: [part] } });

test('claude-code stream-json (no deltas) is detected as generating until the result record', () => {
  const inFlight = claudeSession([
    { type: 'system', subtype: 'init' },
    claudeAssistant({ type: 'text', text: 'On it' })
  ]);
  inFlight.activity = { state: 'running', pid: 12345, queuedTurnCount: 0 };
  const settled = claudeSession([
    { type: 'system', subtype: 'init' },
    claudeAssistant({ type: 'text', text: 'Done' }),
    { type: 'result', subtype: 'success', result: 'Done' }
  ]);

  expect(__workplaceProjectMessageTest.meshSessionIsGenerating(inFlight)).toBe(true);
  expect(__workplaceProjectMessageTest.meshSessionIsGenerating(settled)).toBe(false);
});

test('claude-code activity phase maps assistant/tool/thinking/post records', () => {
  const phaseOf = (part: Record<string, unknown>) =>
    __workplaceProjectMessageTest.meshAgentMemberActivityPhase({
      agentName: 'pmem_claude',
      meshSessions: [],
      liveTools: [
        {
          kind: 'tool',
          id: 'tool_claude',
          tool: 'mesh-agent:claude-code',
          input: { agent: 'pmem_claude' },
          output: [{ type: 'system', subtype: 'init' }, claudeAssistant(part)]
            .map((record) => JSON.stringify(record))
            .join('\n'),
          status: 'running',
          seq: '1'
        }
      ]
    });

  expect(phaseOf({ type: 'text', text: 'Writing the reply' })).toBe('writing');
  expect(phaseOf({ type: 'thinking', thinking: 'Considering options' })).toBe('thinking');
  expect(phaseOf({ type: 'tool_use', name: 'Bash', input: { command: 'ls' } })).toBe('tooling');
  // Posting to the room via the MCP bridge reads as "speaking", not a generic tool call.
  expect(phaseOf({ type: 'tool_use', name: 'mcp__monad__project_post', input: { text: 'joined' } })).toBe('speaking');

  // After the result record the turn is settled — no phase.
  expect(
    __workplaceProjectMessageTest.meshAgentMemberActivityPhase({
      agentName: 'pmem_claude',
      meshSessions: [claudeSession([])],
      liveTools: []
    })
  ).toBeUndefined();
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

test('project rail animation follows working presence and falls back to thinking', () => {
  const workingAgent = agent('claude', 'working');
  const thinkingAgent = { ...agent('codex', 'working'), activityPhase: 'thinking' as const };
  const stalePhaseAgent = { ...agent('gemini', 'online'), activityPhase: 'tooling' as const };

  expect(railAgentActivityPhase(workingAgent)).toBe('thinking');
  expect(shouldAnimateRailAgent(workingAgent)).toBe(true);
  expect(railAgentActivityPhase(thinkingAgent)).toBe('thinking');
  expect(shouldAnimateRailAgent(thinkingAgent)).toBe(true);
  expect(railAgentActivityPhase(stalePhaseAgent)).toBeUndefined();
  expect(shouldAnimateRailAgent(stalePhaseAgent)).toBe(false);
});

const neutralEvent = (
  kind: AgentObservationEvent['kind'],
  overrides: Partial<AgentObservationEvent> = {}
): AgentObservationEvent => ({
  id: `event:${kind}`,
  kind,
  streaming: false,
  provenance: { contractEvents: [{ kind }] },
  ...overrides
});

test('managed member stays working from the daemon turn snapshot before its first streamed message', () => {
  const running = meshSession({
    activity: { state: 'running', pid: 12345, queuedTurnCount: 0 }
  });

  expect(
    meshAgentMemberPresence({
      agentName: running.agentName,
      enabled: true,
      meshSessions: [running],
      liveTools: [
        {
          kind: 'tool',
          id: running.id,
          tool: 'mesh-agent:codex',
          input: { agent: running.agentName },
          output: '\nrunning',
          status: 'ok',
          seq: '1'
        }
      ]
    })
  ).toBe('working');
});

test('managed member activity follows neutral turn boundaries and tool phases', () => {
  const session = meshSession();
  const turn = [
    neutralEvent('turn-start'),
    neutralEvent('tool-call', {
      tool: { name: 'project_inbox_check', input: {} }
    })
  ];

  expect(
    meshAgentMemberPresence({
      agentName: session.agentName,
      enabled: true,
      meshSessions: [session],
      liveTools: [],
      observationEvents: turn
    })
  ).toBe('working');
  expect(
    meshAgentMemberActivityPhase({
      agentName: session.agentName,
      meshSessions: [session],
      liveTools: [],
      observationEvents: turn
    })
  ).toBe('reading');

  const settled = [...turn, neutralEvent('turn-end')];
  expect(
    meshAgentMemberPresence({
      agentName: session.agentName,
      enabled: true,
      meshSessions: [session],
      liveTools: [],
      observationEvents: settled
    })
  ).toBe('idle');
  expect(
    meshAgentMemberActivityPhase({
      agentName: session.agentName,
      meshSessions: [session],
      liveTools: [],
      observationEvents: settled
    })
  ).toBeUndefined();
});

test('managed member activity does not serialize tool input while classifying phases', () => {
  const session = meshSession();
  const poisonedInput = {
    toJSON() {
      throw new Error('tool input should not be serialized for rail activity');
    }
  };
  const turn = [
    neutralEvent('turn-start'),
    neutralEvent('tool-call', {
      tool: { name: 'project_inbox_check', input: poisonedInput }
    })
  ];

  expect(
    meshAgentMemberActivityPhase({
      agentName: session.agentName,
      meshSessions: [session],
      liveTools: [],
      observationEvents: turn
    })
  ).toBe('reading');
  expect(isActiveRailAgent(agent('codex', 'idle'), turn)).toBe(true);
});

test('project rail uses observed turn activity instead of the cached participant presence', () => {
  const cachedIdle = agent('codex', 'idle');
  const activeTurn = [neutralEvent('turn-start'), neutralEvent('assistant-message', { text: 'drafting' })];

  expect(isActiveRailAgent(cachedIdle, activeTurn)).toBe(true);
  expect(railAgentActivityPhase(cachedIdle, activeTurn)).toBe('writing');

  const settledTurn = [...activeTurn, neutralEvent('turn-end')];
  expect(isActiveRailAgent({ ...cachedIdle, presence: 'working' }, settledTurn)).toBe(false);
  expect(railAgentActivityPhase({ ...cachedIdle, presence: 'working' }, settledTurn)).toBeUndefined();
});

test('MeshAgent participant shows thinking while its managed reply is streaming before provider output', () => {
  const participants = __workplaceProjectMessageTest.projectParticipants({
    acpAgents: [],
    activeMeshAgentNames: new Set(['pmem_codex_active']),
    avatarStyle: undefined,
    liveTools: [],
    meshAgentActivityOverrides: {},
    meshAgents: [
      {
        name: 'codex',
        provider: 'codex',
        productIcon: 'codex',
        command: 'codex',
        enabled: true
      } as MeshAgentView
    ],
    meshAgentAvatarSeeds: new Map(),
    meshSessions: [],
    projectMembers: [
      {
        id: 'mesh-agent:pmem_codex_active',
        type: 'mesh-agent',
        name: 'codex',
        templateName: 'codex',
        instanceId: 'pmem_codex_active',
        displayName: 'Codex Reviewer'
      }
    ],
    runningDelegations: new Set()
  });

  expect(
    participants.map((participant) => [participant.name, participant.presence, participant.activityPhase])
  ).toEqual([['Codex Reviewer', 'working', 'thinking']]);
});

test('managed member without a daemon CLI session is idle', () => {
  const participants = __workplaceProjectMessageTest.projectParticipants({
    acpAgents: [],
    avatarStyle: undefined,
    liveTools: [],
    meshAgents: [
      {
        name: 'codex',
        provider: 'codex',
        productIcon: 'codex',
        command: 'codex',
        enabled: true
      } as MeshAgentView
    ],
    meshAgentAvatarSeeds: new Map(),
    meshSessions: [],
    projectMembers: [
      {
        id: 'mesh-agent:pmem_codex_idle',
        type: 'mesh-agent',
        name: 'codex',
        templateName: 'codex',
        instanceId: 'pmem_codex_idle',
        displayName: 'Codex Reviewer'
      }
    ]
  });

  expect(participants.map((participant) => [participant.name, participant.presence])).toEqual([
    ['Codex Reviewer', 'idle']
  ]);
});

test('project rail sorts members by display name without status grouping', () => {
  expect(
    sortedProjectRailAgents([
      agent('Zed', 'working'),
      agent('amy', 'idle'),
      agent('Lily', 'online'),
      agent('Amy', 'working')
    ]).map((item) => item.name)
  ).toEqual(['amy', 'Amy', 'Lily', 'Zed']);
});

test('MeshAgent activity phase reads the running tool output, not a flat tooling', () => {
  // A managed runtime tool card stays 'running' the whole session — with no output yet it is a
  // starting/thinking turn, not "using a tool".
  expect(
    __workplaceProjectMessageTest.meshAgentMemberActivityPhase({
      agentName: 'pmem_codex',
      meshSessions: [],
      liveTools: [
        {
          kind: 'tool',
          id: 'tool_mesh_agent',
          tool: 'mesh-agent:codex',
          input: { agent: 'pmem_codex' },
          status: 'running',
          seq: '3'
        }
      ]
    })
  ).toBe('thinking');

  // Once the running tool's live output shows a provider tool call, the phase becomes 'tooling'.
  expect(
    __workplaceProjectMessageTest.meshAgentMemberActivityPhase({
      agentName: 'pmem_codex',
      meshSessions: [],
      liveTools: [
        {
          kind: 'tool',
          id: 'tool_mesh_agent',
          tool: 'mesh-agent:codex',
          input: { agent: 'pmem_codex' },
          output: [
            '{"method":"turn/started","params":{}}',
            '{"method":"item/started","params":{"item":{"id":"call_1","type":"function_call","name":"exec_command"}}}'
          ].join('\n'),
          status: 'running',
          seq: '3'
        }
      ]
    })
  ).toBe('tooling');

  expect(
    __workplaceProjectMessageTest.meshAgentMemberActivityPhase({
      agentName: 'pmem_codex_active',
      meshSessions: [],
      liveTools: [
        {
          kind: 'tool',
          id: 'tool_codex_writing',
          tool: 'mesh-agent:codex',
          input: { agent: 'pmem_codex_active' },
          output: [
            '{"method":"turn/started","params":{}}',
            '{"method":"item/agentMessage/delta","params":{"delta":"Working"}}'
          ].join('\n'),
          status: 'running',
          seq: '4'
        }
      ]
    })
  ).toBe('writing');
});

test('a neutral turn-end clears working even while the session snapshot still reads generating', () => {
  const generatingSnapshot = meshSession({
    activity: { state: 'running', pid: 12345, queuedTurnCount: 0 },
    outputSnapshot: [
      '{"method":"turn/started","params":{}}',
      '{"method":"item/agentMessage/delta","params":{"delta":"Working"}}'
    ].join('\n')
  });
  const longLivedTool = {
    kind: 'tool' as const,
    id: 'mesh_codexrunning',
    tool: 'mesh-agent:codex',
    input: { agent: 'pmem_codex_active' },
    status: 'ok' as const,
    seq: '9'
  };

  expect(__workplaceProjectMessageTest.meshSessionIsGenerating(generatingSnapshot)).toBe(true);

  expect(
    __workplaceProjectMessageTest.meshAgentMemberPresence({
      agentName: 'pmem_codex_active',
      enabled: true,
      meshSessions: [generatingSnapshot],
      liveTools: [longLivedTool],
      observationEvents: [neutralEvent('turn-start'), neutralEvent('turn-end')]
    })
  ).toBe('idle');
  expect(
    __workplaceProjectMessageTest.meshAgentMemberActivityPhase({
      agentName: 'pmem_codex_active',
      meshSessions: [generatingSnapshot],
      liveTools: [longLivedTool],
      observationEvents: [neutralEvent('turn-start'), neutralEvent('turn-end')]
    })
  ).toBeUndefined();
});

test('a live managed runtime wins over a newer terminal sibling while its turn is active', () => {
  const olderStopped = meshSession({
    id: 'mesh_stopped',
    state: 'stopped',
    updatedAt: '2026-07-17T05:46:10.100Z',
    exitedAt: '2026-07-17T05:46:10.100Z'
  });
  const running = meshSession({
    id: 'mesh_running',
    activity: { state: 'running', pid: 12345, queuedTurnCount: 0 },
    outputSnapshot: [
      '{"method":"turn/started","params":{}}',
      '{"method":"item/agentMessage/delta","params":{"delta":"Working"}}'
    ].join('\n'),
    updatedAt: '2026-07-17T05:46:10.000Z'
  });

  expect(
    __workplaceProjectMessageTest.meshAgentMemberPresence({
      agentName: 'pmem_codex_active',
      enabled: true,
      meshSessions: [olderStopped, running],
      liveTools: []
    })
  ).toBe('working');
});

test('MeshAgent activity phase treats provider tool calls as tooling', () => {
  expect(
    __workplaceProjectMessageTest.meshAgentMemberActivityPhase({
      agentName: 'pmem_codex_active',
      meshSessions: [],
      liveTools: [
        {
          kind: 'tool',
          id: 'tool_codex_call',
          tool: 'mesh-agent:codex',
          input: { agent: 'pmem_codex_active' },
          output: [
            '{"method":"turn/started","params":{}}',
            '{"method":"item/started","params":{"item":{"id":"call_1","type":"function_call","name":"exec_command"}}}'
          ].join('\n'),
          status: 'running',
          seq: '5'
        }
      ]
    })
  ).toBe('tooling');
});

test('MeshAgent activity phase treats provider reasoning as thinking', () => {
  expect(
    __workplaceProjectMessageTest.meshAgentMemberActivityPhase({
      agentName: 'pmem_codex_active',
      meshSessions: [],
      liveTools: [
        {
          kind: 'tool',
          id: 'tool_codex_reasoning',
          tool: 'mesh-agent:codex',
          input: { agent: 'pmem_codex_active' },
          output: [
            '{"method":"turn/started","params":{}}',
            '{"method":"item/reasoning/textDelta","params":{"delta":"Need inspect."}}'
          ].join('\n'),
          status: 'running',
          seq: '6'
        }
      ]
    })
  ).toBe('thinking');
});

test('MeshAgent running sessions without provider activity stay idle', () => {
  const idleRunningSession = meshSession({
    state: 'running',
    outputSnapshot: '',
    updatedAt: '2026-07-06T11:15:26.926Z'
  });

  expect(__workplaceProjectMessageTest.meshSessionIsGenerating(idleRunningSession)).toBe(false);
  expect(
    __workplaceProjectMessageTest.meshAgentMemberPresence({
      agentName: 'pmem_codex_active',
      enabled: true,
      meshSessions: [idleRunningSession],
      liveTools: []
    })
  ).toBe('online');
  expect(
    __workplaceProjectMessageTest.meshAgentMemberActivityPhase({
      agentName: 'pmem_codex_active',
      meshSessions: [idleRunningSession],
      liveTools: []
    })
  ).toBeUndefined();
});

test('MeshAgent-facing project commands map to short activity phases', () => {
  expect(__workplaceProjectMessageTest.meshAgentFacingCommandPhase('Bash: monad project post -')).toBe('speaking');
  expect(__workplaceProjectMessageTest.meshAgentFacingCommandPhase('monad project send "done"')).toBe('speaking');
  expect(__workplaceProjectMessageTest.meshAgentFacingCommandPhase('monad project inbox check')).toBe('reading');
  expect(__workplaceProjectMessageTest.meshAgentFacingCommandPhase('monad inbox read')).toBe('reading');
  expect(__workplaceProjectMessageTest.meshAgentFacingCommandPhase('monad project read --project undefined')).toBe(
    'reading'
  );
});

test('MeshAgent stopped sessions remain available when the template is enabled', () => {
  const presence = __workplaceProjectMessageTest.meshAgentMemberPresence({
    agentName: 'pmem_codex_available',
    enabled: true,
    meshSessions: [
      meshSession({
        id: 'mesh_stopped00000',
        agentName: 'pmem_codex_available',
        agentRuntimeId: 'mesh_stopped00000',
        state: 'stopped',
        pid: null,
        providerSessionRef: 'codex-thread',
        exitCode: 0,
        updatedAt: '2026-06-29T10:01:00.000Z',
        exitedAt: '2026-06-29T10:01:00.000Z'
      })
    ],
    liveTools: []
  });

  expect(presence).toBe('online');
});

test('MeshAgent generating flag follows execution activity for the same session id', () => {
  const running = meshSession({ activity: { state: 'running', pid: 12345, queuedTurnCount: 0 } });
  const idle = meshSession({ activity: { state: 'idle', pid: null, queuedTurnCount: 0 } });

  expect(__workplaceProjectMessageTest.meshSessionIsGenerating(running)).toBe(true);
  expect(__workplaceProjectMessageTest.meshSessionIsGenerating(idle)).toBe(false);
});

test('MeshAgent presence follows provider turn activity before a project message streams', () => {
  const generatingSession = meshSession({ activity: { state: 'running', pid: 12345, queuedTurnCount: 0 } });
  const idleSession = meshSession({ activity: { state: 'idle', pid: null, queuedTurnCount: 0 } });

  expect(__workplaceProjectMessageTest.meshSessionIsGenerating(generatingSession)).toBe(true);
  expect(
    __workplaceProjectMessageTest.meshAgentMemberPresence({
      agentName: 'pmem_codex_active',
      enabled: true,
      meshSessions: [generatingSession],
      liveTools: []
    })
  ).toBe('working');

  expect(__workplaceProjectMessageTest.meshSessionIsGenerating(idleSession)).toBe(false);
  expect(
    __workplaceProjectMessageTest.meshAgentMemberPresence({
      agentName: 'pmem_codex_active',
      enabled: true,
      meshSessions: [idleSession],
      liveTools: []
    })
  ).toBe('online');
});

test('MeshAgent presence returns to online after Claude Code result', () => {
  const generatingSession = meshSession({
    provider: 'claude-code',
    productIcon: 'claude-code',
    activity: { state: 'running', pid: 12345, queuedTurnCount: 0 }
  });
  const idleSession = meshSession({
    provider: 'claude-code',
    productIcon: 'claude-code',
    activity: { state: 'idle', pid: null, queuedTurnCount: 0 }
  });

  expect(__workplaceProjectMessageTest.meshSessionIsGenerating(generatingSession)).toBe(true);
  expect(__workplaceProjectMessageTest.meshSessionIsGenerating(idleSession)).toBe(false);
  expect(
    __workplaceProjectMessageTest.meshAgentMemberPresence({
      agentName: 'pmem_codex_active',
      enabled: true,
      meshSessions: [idleSession],
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

test('chatroom experience store isolates rail observations by project session instance', () => {
  const firstKey = 'project:project-1:session:ses_first';
  const secondKey = 'project:project-1:session:ses_second';

  useChatRoomExperienceStore.getState().followMeshSession(firstKey, 'project-1', 'ncli:codex');
  useChatRoomExperienceStore.getState().observeProjectAgent(secondKey, 'project-1', {
    agentId: 'mesh-agent:codex',
    agentName: 'codex'
  });

  expect(useChatRoomExperienceStore.getState().railObservationBySession).toEqual({
    [firstKey]: {
      projectId: 'project-1',
      meshSessionId: 'ncli:codex'
    },
    [secondKey]: {
      projectId: 'project-1',
      agentId: 'mesh-agent:codex',
      agentName: 'codex'
    }
  });

  useChatRoomExperienceStore.getState().closeRailObservation(firstKey);
  expect(useChatRoomExperienceStore.getState().railObservationBySession).toEqual({
    [secondKey]: {
      projectId: 'project-1',
      agentId: 'mesh-agent:codex',
      agentName: 'codex'
    }
  });
});

test('chatroom file preview is session scoped and replaces observation detail', () => {
  const firstKey = 'project:project-file:session:ses_first';
  const secondKey = 'project:project-file:session:ses_second';
  const attachment = {
    id: 'att_100000000000',
    path: '/workspace/report.ts',
    name: 'report.ts',
    mime: 'application/typescript',
    bytes: 42,
    createdAt: '2026-07-18T00:00:00.000Z'
  } as const;

  useChatRoomExperienceStore.getState().observeProjectAgent(firstKey, 'project-file', {
    agentId: 'mesh-agent:codex',
    agentName: 'codex'
  });
  useChatRoomExperienceStore.getState().openFilePreview(firstKey, { attachment, line: 12 });

  expect(useChatRoomExperienceStore.getState().railObservationBySession[firstKey]).toBeUndefined();
  expect(useChatRoomExperienceStore.getState().filePreviewBySession).toEqual({
    [firstKey]: { attachment, line: 12 }
  });
  expect(useChatRoomExperienceStore.getState().filePreviewBySession[secondKey]).toBeUndefined();

  useChatRoomExperienceStore.getState().observeProjectAgent(firstKey, 'project-file', {
    agentId: 'mesh-agent:claude',
    agentName: 'claude'
  });
  expect(useChatRoomExperienceStore.getState().filePreviewBySession[firstKey]).toBeUndefined();
  useChatRoomExperienceStore.getState().removeSessionUiState(firstKey);
});

test('agent observation selects the currently running MeshAgent stream by instance id', () => {
  const streams = [
    {
      id: 'mesh_old000000000',
      agentName: 'pmem_codex_one',
      provider: 'codex',
      tag: 'Codex',
      status: 'ok' as const,
      output: '',
      items: []
    },
    {
      id: 'mesh_running00000',
      agentName: 'pmem_codex_one',
      provider: 'codex',
      tag: 'Codex',
      status: 'running' as const,
      output: 'thinking',
      items: [messageCard('item_1', 'Thinking')]
    },
    {
      id: 'mesh_otherproject',
      agentName: 'codex',
      provider: 'codex',
      tag: 'Codex',
      status: 'running' as const,
      output: 'wrong project',
      items: []
    }
  ];

  expect(agentObservationStream({ agentId: 'pmem_codex_one', agentName: 'Codex' }, streams)?.id).toBe(
    'mesh_running00000'
  );
  expect(agentObservationStream({ meshSessionId: 'mesh_old000000000' }, streams)?.id).toBe('mesh_old000000000');
});

test('agent observation follows the newest MeshAgent stream when no runtime is running', () => {
  const streams = [
    {
      id: 'mesh_old000000000',
      agentName: 'pmem_codex_one',
      provider: 'codex',
      tag: 'Codex',
      status: 'ok' as const,
      output: '',
      items: []
    },
    {
      id: 'mesh_new000000000',
      agentName: 'pmem_codex_one',
      provider: 'codex',
      tag: 'Codex',
      status: 'ok' as const,
      output: 'newer session',
      items: [],
      observedAt: '2026-07-06T10:00:00.000Z'
    },
    {
      id: 'mesh_mid000000000',
      agentName: 'pmem_codex_one',
      provider: 'codex',
      tag: 'Codex',
      status: 'ok' as const,
      output: 'older session',
      items: [],
      observedAt: '2026-07-06T09:00:00.000Z'
    }
  ];

  expect(agentObservationStream({ agentId: 'pmem_codex_one', agentName: 'Codex' }, streams)?.id).toBe(
    'mesh_new000000000'
  );
});

test('agent observation matches MeshAgent stream aliases for template-backed project members', () => {
  const streams = [
    {
      id: 'mesh_codextem5VBW',
      agentName: 'codex',
      agentAliases: ['pmem_codex_1a6c1dcc142', 'codex', 'Lily'],
      provider: 'codex',
      tag: 'Codex',
      status: 'running' as const,
      output: 'projected activity',
      items: [messageCard('item_1', 'Projected activity')]
    }
  ];

  expect(agentObservationStream({ agentId: 'pmem_codex_1a6c1dcc142', agentName: 'Lily' }, streams)?.id).toBe(
    'mesh_codextem5VBW'
  );
});

test('project messages do not bind membership joins to runtime sessions', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    meshSessions: [
      meshSession({
        id: 'mesh_old000000000',
        agentName: 'pmem_codex_one',
        state: 'stopped',
        startedAt: '2026-07-06T08:00:00.000Z',
        updatedAt: '2026-07-06T08:01:00.000Z',
        exitedAt: '2026-07-06T08:01:00.000Z'
      }),
      meshSession({
        id: 'mesh_new000000000',
        agentName: 'pmem_codex_one',
        state: 'running',
        startedAt: '2026-07-06T09:00:00.000Z',
        updatedAt: '2026-07-06T09:01:00.000Z'
      })
    ],
    liveItems: [],
    liveTools: [],
    meshAgentDisplayNames: new Map([['pmem_codex_one', 'Codex']])
  });

  expect(messages).toEqual([]);
});

test('MeshAgent member join renders from the invitation and stays after the agent replies', () => {
  const pendingMessages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    projectMembers: [
      {
        id: 'pmem_codex_one',
        type: 'mesh-agent',
        name: 'codex',
        instanceId: 'pmem_codex_one',
        displayName: 'Codex',
        joinedAt: '2026-07-06T08:59:00.000Z'
      }
    ],
    meshSessions: [],
    liveItems: [],
    liveTools: [
      {
        id: 'mesh_toollaunch01',
        kind: 'tool',
        tool: 'mesh-agent:codex',
        input: { agent: 'pmem_codex_one', productIcon: 'codex', provider: 'codex' },
        status: 'running',
        seq: '2026-07-06T09:00:00.000Z'
      }
    ],
    meshAgentDisplayNames: new Map([['pmem_codex_one', 'Codex']])
  });

  const joinMessage = pendingMessages.find((message) => message.id === 'project-member-joined:pmem_codex_one');
  expect(joinMessage).toEqual(
    expect.objectContaining({
      id: 'project-member-joined:pmem_codex_one',
      kind: 'system',
      text: 'joined the project'
    })
  );
  expect(joinMessage?.systemTone).toBeUndefined();

  const mergedMessages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    projectMembers: [
      {
        id: 'pmem_codex_one',
        type: 'mesh-agent',
        name: 'codex',
        instanceId: 'pmem_codex_one',
        displayName: 'Codex',
        joinedAt: '2026-07-06T08:59:00.000Z'
      }
    ],
    meshSessions: [],
    liveItems: [
      {
        id: 'msg_externali36l',
        kind: 'message',
        role: 'assistant',
        agentName: 'pmem_codex_one',
        meshSessionId: 'mesh_toollaunch01',
        source: 'managed-mesh-agent',
        status: 'done',
        seq: '2026-07-06T09:00:01.000Z',
        parts: [{ type: 'text', text: 'Ready.' }]
      }
    ],
    liveTools: [
      {
        id: 'mesh_toollaunch01',
        kind: 'tool',
        tool: 'mesh-agent:codex',
        input: { agent: 'pmem_codex_one', productIcon: 'codex', provider: 'codex' },
        status: 'running',
        seq: '2026-07-06T09:00:00.000Z'
      }
    ],
    meshAgentDisplayNames: new Map([['pmem_codex_one', 'Codex']])
  });

  expect(mergedMessages.some((message) => message.id === 'project-member-joined:pmem_codex_one')).toBe(true);
  expect(mergedMessages.find((message) => message.id === 'msg_externali36l')?.text).toBe('Ready.');
});

test('MeshAgent member join history stays visible after agent content arrives', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    projectMembers: [
      {
        id: 'pmem_codex_one',
        type: 'mesh-agent',
        name: 'codex',
        instanceId: 'pmem_codex_one',
        displayName: 'Codex',
        joinedAt: '2026-07-06T08:59:00.000Z'
      }
    ],
    meshSessions: [meshSession({ agentName: 'pmem_codex_one', id: 'mesh_history00000' })],
    liveItems: [
      {
        id: 'msg_externali36l',
        kind: 'message',
        role: 'assistant',
        agentName: 'pmem_codex_one',
        meshSessionId: 'mesh_history00000',
        source: 'managed-mesh-agent',
        status: 'done',
        seq: '2026-07-06T09:00:01.000Z',
        parts: [{ type: 'text', text: 'Ready.' }]
      }
    ],
    liveTools: [],
    meshAgentDisplayNames: new Map([['pmem_codex_one', 'Codex']])
  });

  const joinMessage = messages.find((message) => message.id === 'project-member-joined:pmem_codex_one');
  expect(joinMessage).toEqual(
    expect.objectContaining({
      kind: 'system',
      text: 'joined the project'
    })
  );
  expect(joinMessage?.systemTone).toBeUndefined();
  expect(messages.find((message) => message.id === 'msg_externali36l')?.text).toBe('Ready.');
});

test('MeshAgent session observation reuses the project member identity', () => {
  const railAgent = {
    ...agent('Lily', 'online'),
    id: 'pmem_codex_1a6c1dcc142',
    avatarUrl: '/api/avatar-cache/lily.svg?seed=Lily',
    icon: 'codex'
  } as Participant;
  const stream = {
    id: 'mesh_codex0000000',
    agentName: 'pmem_codex_1a6c1dcc142',
    provider: 'codex',
    tag: 'Codex',
    status: 'ok' as const,
    output: '',
    items: []
  };

  expect(observedRailAgent({ meshSessionId: 'mesh_codex0000000' }, stream, [railAgent])).toBe(railAgent);
});
