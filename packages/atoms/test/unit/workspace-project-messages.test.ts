import type { AgentObservationCard, MeshSessionView } from '@monad/protocol';
import type { Message } from '../../src/workspace-experiences/experience/types.ts';

import { expect, test } from 'bun:test';

import { builtinAgentAdapters } from '../../src/agent-adapters/index.ts';
import {
  __workplaceProjectMessageTest,
  messageToView
} from '../../src/workspace-experiences/chat-room/utils/projection.ts';
import { configureMeshAgentObservationAdapterResolver } from '../../src/workspace-experiences/experience/mesh-agent-observation/mesh-agent-observation.ts';
import { projectMemberParticipants } from '../../src/workspace-experiences/experience/project-projection.ts';

configureMeshAgentObservationAdapterResolver((provider) =>
  builtinAgentAdapters.find((adapter) => adapter.provider === provider)
);

test('project message projection preserves display-only attachment metadata', () => {
  const attachment = {
    id: 'att_01ABC0000000' as const,
    name: 'diagram.png',
    mime: 'image/png',
    bytes: 4321,
    createdAt: '2026-07-19T00:00:00.000Z'
  };

  expect(
    messageToView({
      kind: 'message',
      id: 'msg_01ABC0000000',
      role: 'user',
      parts: [
        { type: 'text', text: 'Review this.' },
        { type: 'custom', name: 'attachment', data: attachment }
      ],
      status: 'done',
      seq: '2026-07-19T00:00:00.000Z'
    }).attachments
  ).toEqual([attachment]);
});

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
  const at = exitedAt ?? '2026-06-29T10:00:00.000Z';
  return {
    id: 'mesh_01KWGEMIprD4',
    sessionId: 'ses_01KWPROJ2tDh',
    agentName: 'gemini',
    provider: 'gemini',
    productIcon: 'gemini',
    workingPath: '/Users/test/Projects/monad',
    approvalOwnership: 'provider-owned',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: 'mesh_01KWGEMIprD4',
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
      steer: false,
      interrupt: true,
      approvalResolution: false,
      providerSessionContinuation: true,
      runtimeRestoration: true,
      sessionReopen: true
    },
    providerSessionRef: null,
    startedAt: '2026-06-29T10:00:00.000Z',
    updatedAt: '2026-06-29T10:00:00.000Z',
    ...current,
    pendingApprovalCount: overrides.pendingApprovalCount ?? 0
  };
};

const observationFields = (
  items: NonNullable<ReturnType<typeof __workplaceProjectMessageTest.buildMeshAgentStreams>[number]>['items']
) =>
  items.map(({ id, payload }) => {
    const event = payload.event ?? payload.call ?? payload.result;
    const text = event && typeof event === 'object' && 'text' in event ? event.text : undefined;
    return { id, text };
  });

function messageCard(id: string, text: string, provider: string): AgentObservationCard {
  const contractEvent = {
    id,
    role: 'agent',
    text,
    source: 'plain-text',
    provenance: { rawEvents: [text] }
  };
  return {
    id,
    kind: 'message',
    streaming: false,
    payload: {
      provider,
      event: {
        id,
        kind: 'assistant-message',
        streaming: false,
        text,
        provenance: { contractEvents: [contractEvent] }
      }
    },
    provenance: { contractEvents: [contractEvent] }
  };
}

function firstMeshAgentStream(streams: ReturnType<typeof __workplaceProjectMessageTest.buildMeshAgentStreams>) {
  const stream = streams[0];
  if (!stream) throw new Error('expected an MeshAgent stream');
  return stream;
}

test('MeshAgent member invitations project to durable chat messages', () => {
  const [message] = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    projectMembers: [
      {
        id: 'pmem_gemini',
        type: 'mesh-agent',
        name: 'gemini',
        instanceId: 'pmem_gemini',
        joinedAt: '2026-06-29T10:00:00.000Z'
      }
    ],
    meshSessions: [],
    liveItems: [],
    liveTools: [],
    meshAgentIcons: new Map([['pmem_gemini', 'gemini']]),
    meshAgentTags: new Map([['pmem_gemini', 'Gemini']])
  });

  expect(message).toMatchObject({
    id: 'project-member-joined:pmem_gemini',
    authorName: 'gemini',
    icon: 'gemini',
    kind: 'system',
    tag: 'Gemini',
    text: 'joined the project',
    agentChip: {
      id: 'pmem_gemini',
      name: 'gemini',
      icon: 'gemini',
      tag: 'Gemini'
    },
    streaming: false,
    orderKey: '2026-06-29T10:00:00.000Z'
  });
});

test('MeshAgent login-required custom items project to chat system messages', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    projectMembers: [
      {
        id: 'pmem_claude-code_f2654d392ff2',
        type: 'mesh-agent',
        name: 'claude-code',
        instanceId: 'pmem_claude-code_f2654d392ff2',
        displayName: 'Opus',
        joinedAt: '2026-07-20T05:26:38.637Z'
      }
    ],
    meshSessions: [],
    liveItems: [
      {
        kind: 'custom',
        id: 'mesh-agent-login-required:pmem_claude-code_f2654d392ff2',
        name: 'mesh.login_required',
        status: 'error',
        data: {
          agentName: 'pmem_claude-code_f2654d392ff2',
          authAgentName: 'claude-code',
          provider: 'claude-code',
          reason: 'Reconnect claude-code in Studio before using it in this project.'
        },
        seq: 'evt_loginRequired'
      }
    ],
    liveTools: [],
    meshAgentDisplayNames: new Map([['pmem_claude-code_f2654d392ff2', 'Opus']]),
    meshAgentIcons: new Map([['pmem_claude-code_f2654d392ff2', 'claude-code']]),
    meshAgentTags: new Map([['pmem_claude-code_f2654d392ff2', 'Claude']])
  });

  expect(messages.map((message) => ({ id: message.id, kind: message.kind, text: message.text }))).toEqual([
    {
      id: 'project-member-joined:pmem_claude-code_f2654d392ff2',
      kind: 'system',
      text: 'joined the project'
    },
    {
      id: 'mesh-agent-login-required:pmem_claude-code_f2654d392ff2',
      kind: 'system',
      text: 'request sign in.'
    }
  ]);
  expect(messages[1]).toMatchObject({
    authorId: 'pmem_claude-code_f2654d392ff2',
    authorName: 'Opus',
    agentChip: {
      id: 'pmem_claude-code_f2654d392ff2',
      name: 'Opus',
      icon: 'claude-code',
      tag: 'Claude'
    },
    systemActions: [
      {
        actionId: 'mesh-agent.sign-in',
        payload: {
          agentName: 'claude-code',
          projectMemberId: 'pmem_claude-code_f2654d392ff2',
          provider: 'claude-code'
        }
      }
    ],
    systemTone: 'error'
  });
});

test('project rail only includes Monad when explicitly invited', () => {
  expect(
    projectMemberParticipants([
      {
        id: 'monad',
        av: 'MO',
        icon: 'monad',
        name: 'monad',
        kind: 'agent',
        tag: 'AI',
        presence: 'online'
      }
    ])
  ).toEqual([
    {
      id: 'monad',
      av: 'MO',
      icon: 'monad',
      name: 'monad',
      kind: 'agent',
      tag: 'AI',
      presence: 'online'
    }
  ]);
});

test('Monad project member parses as a normal project member', () => {
  expect(__workplaceProjectMessageTest.parseProjectMembers([{ id: 'monad', type: 'monad', name: 'monad' }])).toEqual([
    { id: 'monad', type: 'monad', name: 'monad' }
  ]);
});

test('MeshAgent developer messages expose only a follow entry', () => {
  const message = __workplaceProjectMessageTest.meshSessionDeveloperMessage(meshSession());

  expect(message).toMatchObject({
    id: 'mesh-session-developer:mesh_01KWGEMIprD4',
    kind: 'developer',
    tag: 'DEV',
    text: 'CLI stream available',
    meshSessionId: 'mesh_01KWGEMIprD4',
    developerOnly: true,
    orderKey: '2026-06-29T10:00:00.000Z:developer'
  });
});

test('member invitation projects one join message across runtime restarts', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    projectMembers: [
      {
        id: 'pmem_gemini_reviewer',
        type: 'mesh-agent',
        name: 'gemini',
        instanceId: 'pmem_gemini_reviewer',
        displayName: 'Reviewer',
        joinedAt: '2026-06-29T09:59:00.000Z'
      }
    ],
    meshSessions: [
      meshSession({
        id: 'mesh_oldruntime001',
        agentName: 'pmem_gemini_reviewer',
        startedAt: '2026-06-29T10:00:00.000Z'
      }),
      meshSession({
        id: 'mesh_newruntime001',
        agentName: 'pmem_gemini_reviewer',
        startedAt: '2026-06-29T11:00:00.000Z'
      })
    ],
    liveItems: [],
    liveTools: [],
    meshAgentDisplayNames: new Map([['pmem_gemini_reviewer', 'Reviewer']]),
    meshAgentIcons: new Map([['pmem_gemini_reviewer', 'gemini']]),
    meshAgentTags: new Map([['pmem_gemini_reviewer', 'Gemini']])
  });

  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    id: 'project-member-joined:pmem_gemini_reviewer',
    authorId: 'pmem_gemini_reviewer',
    authorName: 'Reviewer',
    kind: 'system',
    text: 'joined the project',
    agentChip: { id: 'pmem_gemini_reviewer', name: 'Reviewer' },
    orderKey: '2026-06-29T09:59:00.000Z'
  });
});

test('runtime startup without a member invitation does not project a join message', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    projectMembers: [],
    meshSessions: [meshSession()],
    liveItems: [],
    liveTools: [
      {
        id: 'mesh_live00000000',
        kind: 'tool',
        tool: 'mesh-agent:gemini',
        input: { agent: 'gemini', provider: 'gemini', productIcon: 'gemini' },
        status: 'running',
        seq: '002'
      } as never
    ]
  });

  expect(messages.map((message) => message.text)).toEqual([]);
});

test('provider output embedded in a session snapshot does not create chat messages', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    meshSessions: [
      meshSession({
        id: 'mesh_claudeerror0',
        agentName: 'pmem_claude_1234',
        provider: 'claude-code',
        productIcon: 'claude-code',
        startedAt: '2026-06-29T10:00:00.000Z',
        updatedAt: '2026-06-29T10:00:05.000Z',
        outputSnapshot: JSON.stringify({
          type: 'result',
          subtype: 'server_error',
          is_error: true,
          result: 'API Error: overloaded_error. Claude Code is currently overloaded.',
          session_id: 'claude-session'
        })
      })
    ],
    liveItems: [],
    liveTools: [],
    meshAgentDisplayNames: new Map([['pmem_claude_1234', 'Steve']])
  });

  expect(messages).toEqual([]);
});

test('MeshAgent developer messages are projected only when explicitly enabled', () => {
  const hidden = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    meshSessions: [],
    liveItems: [],
    liveTools: [
      {
        id: 'mesh_live00000000',
        kind: 'tool',
        tool: 'mesh-agent:codex',
        input: { agent: 'codex', provider: 'codex', productIcon: 'codex' },
        output: 'raw terminal output',
        status: 'running',
        seq: '002'
      } as never
    ]
  });
  const visible = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    meshSessions: [],
    liveItems: [],
    liveTools: [
      {
        id: 'mesh_live00000000',
        kind: 'tool',
        tool: 'mesh-agent:codex',
        input: { agent: 'codex', provider: 'codex', productIcon: 'codex' },
        output: 'raw terminal output',
        status: 'running',
        seq: '002'
      } as never
    ],
    showDeveloperOnlyMessages: true
  });

  expect(hidden.map((message) => [message.kind, message.text])).toEqual([]);
  expect(visible.map((message) => [message.kind, message.text])).toEqual([['developer', 'CLI stream available']]);
});

test('MeshAgent runtime lifecycle does not project member joins', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    meshSessions: [
      meshSession({
        id: 'mesh_first0000000',
        agentName: 'codex',
        provider: 'codex',
        productIcon: 'codex',
        state: 'stopped',
        startedAt: '2026-06-29T10:00:00.000Z',
        updatedAt: '2026-06-29T10:01:00.000Z',
        exitedAt: '2026-06-29T10:01:00.000Z'
      }),
      meshSession({
        id: 'mesh_second000000',
        agentName: 'codex',
        provider: 'codex',
        productIcon: 'codex',
        state: 'running',
        startedAt: '2026-06-29T10:02:00.000Z',
        updatedAt: '2026-06-29T10:02:00.000Z'
      })
    ],
    liveItems: [],
    liveTools: [],
    showDeveloperOnlyMessages: false
  });

  expect(messages).toEqual([]);
});

test('managed MeshAgent timeline messages use display names instead of runtime ids', () => {
  const displayNames = new Map([['pmem_codex_abcd1234', 'codex-reviewer']]);
  const avatarSeeds = new Map([['codex-reviewer', 'mesh-agent:codex-reviewer']]);
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    meshSessions: [
      meshSession({
        id: 'mesh_display00000',
        agentName: 'pmem_codex_abcd1234',
        provider: 'codex',
        productIcon: 'codex'
      })
    ],
    liveItems: [
      {
        kind: 'message',
        id: 'msg_clireply0000',
        role: 'assistant',
        agentName: 'pmem_codex_abcd1234',
        source: 'managed-mesh-agent',
        parts: [{ type: 'text', text: 'Ready.' }],
        status: 'done',
        seq: '2026-06-29T10:00:01.000Z'
      }
    ],
    liveTools: [],
    meshAgentAvatarSeeds: avatarSeeds,
    meshAgentDisplayNames: displayNames,
    showDeveloperOnlyMessages: false
  });

  expect(messages.map((message) => message.authorName)).toEqual(['codex-reviewer']);
  expect(messages.map((message) => message.authorId)).toEqual(['pmem_codex_abcd1234']);
});

test('managed MeshAgent reasoning-only streaming messages stay off the transcript wall', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    meshSessions: [],
    liveItems: [
      {
        kind: 'message',
        id: 'msg_codexthi658B',
        role: 'assistant',
        agentName: 'pmem_codex_abcd1234',
        source: 'managed-mesh-agent',
        parts: [{ type: 'reasoning', text: 'Thinking' }],
        status: 'streaming',
        seq: '002'
      }
    ],
    liveTools: [],
    meshAgentDisplayNames: new Map([['pmem_codex_abcd1234', 'codex-reviewer']])
  });
  expect(messages).toEqual([]);
});

test('managed MeshAgent terminal reasoning-only messages stay off the transcript wall', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    meshSessions: [],
    liveItems: [
      {
        kind: 'message',
        id: 'msg_codexorpsSFT',
        role: 'assistant',
        agentName: 'pmem_codex_abcd1234',
        source: 'managed-mesh-agent',
        parts: [{ type: 'reasoning', text: 'Thinking' }],
        status: 'error',
        seq: '002'
      }
    ],
    liveTools: [],
    meshAgentDisplayNames: new Map([['pmem_codex_abcd1234', 'codex-reviewer']])
  });
  expect(messages).toEqual([]);
});

test('MeshAgent live start exposes developer follow without projecting a join', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    meshSessions: [],
    liveItems: [],
    liveTools: [
      {
        id: 'mesh_live00000000',
        kind: 'tool',
        tool: 'mesh-agent:claude-code',
        input: { agent: 'claude-code', provider: 'claude-code', productIcon: 'claude-code' },
        output: 'started claude-code\n\\x1b[38;2;255;193;7mraw terminal output',
        status: 'running',
        seq: '002'
      } as never
    ],
    showDeveloperOnlyMessages: true
  });

  const developer = messages.find((message) => message.kind === 'developer');
  expect(messages.filter((message) => message.kind === 'system')).toEqual([]);
  expect(developer).toMatchObject({
    id: 'mesh-session-developer:mesh_live00000000',
    text: 'CLI stream available',
    meshSessionId: 'mesh_live00000000'
  });
});

test('MeshAgent live starts do not project member joins', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    meshSessions: [],
    liveItems: [],
    liveTools: [
      {
        id: 'mesh_first0000000',
        kind: 'tool',
        tool: 'mesh-agent:codex',
        input: { agent: 'pmem_codex_a', provider: 'codex', productIcon: 'codex' },
        status: 'running',
        seq: '001'
      } as never,
      {
        id: 'mesh_second000000',
        kind: 'tool',
        tool: 'mesh-agent:codex',
        input: { agent: 'pmem_codex_a', provider: 'codex', productIcon: 'codex' },
        status: 'running',
        seq: '002'
      } as never
    ],
    meshAgentDisplayNames: new Map([['pmem_codex_a', 'A']])
  });

  expect(messages).toEqual([]);
});

test('managed MeshAgent reasoning-only fanout does not project a system divider', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [
      {
        id: 'msg_user00000000',
        authorId: 'me',
        authorName: 'Operator',
        av: 'ME',
        kind: 'human',
        tag: 'User',
        time: '10:00',
        text: 'hi',
        orderKey: '001'
      }
    ],
    meshSessions: [],
    liveItems: [
      {
        kind: 'message',
        id: 'msg_codexthi658B',
        role: 'assistant',
        agentName: 'codex',
        source: 'managed-mesh-agent',
        parts: [{ type: 'reasoning', text: 'Thinking' }],
        status: 'streaming',
        seq: '002'
      },
      {
        kind: 'message',
        id: 'msg_claudethDTNA',
        role: 'assistant',
        agentName: 'claude-code',
        source: 'managed-mesh-agent',
        parts: [{ type: 'reasoning', text: 'Thinking' }],
        status: 'streaming',
        seq: '003'
      }
    ],
    liveTools: []
  });

  expect(messages).toHaveLength(1);
  expect(messages.map((message) => message.id)).toEqual(['msg_user00000000']);
});

test('managed MeshAgent finished replies render without a thinking placeholder', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [
      {
        id: 'msg_user00000000',
        authorId: 'me',
        authorName: 'Operator',
        av: 'ME',
        kind: 'human',
        tag: 'User',
        time: '10:00',
        text: 'hi',
        orderKey: '001'
      }
    ],
    meshSessions: [],
    liveItems: [
      {
        kind: 'message',
        id: 'msg_codexreply00',
        role: 'assistant',
        agentName: 'codex',
        source: 'managed-mesh-agent',
        parts: [{ type: 'text', text: 'Done.' }],
        status: 'done',
        seq: '002'
      },
      {
        kind: 'message',
        id: 'msg_claudethDTNA',
        role: 'assistant',
        agentName: 'claude-code',
        source: 'managed-mesh-agent',
        parts: [{ type: 'reasoning', text: 'Thinking' }],
        status: 'streaming',
        seq: '003'
      }
    ],
    liveTools: []
  });

  expect(messages.map((message) => message.id)).toEqual(['msg_user00000000', 'msg_codexreply00']);
});

test('managed MeshAgent finished replies retain delivery observation pointers', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    meshSessions: [],
    liveItems: [
      {
        kind: 'message',
        id: 'msg_codexreply00',
        role: 'assistant',
        agentName: 'pmem_codex_abcd1234',
        source: 'managed-mesh-agent',
        meshSessionId: 'mesh_codexdelTeTK',
        deliveryId: 'deliv_01KWEBDErrBa',
        parts: [{ type: 'text', text: 'Done.' }],
        status: 'done',
        seq: '2026-06-29T10:00:01.000Z'
      }
    ],
    liveTools: [],
    meshAgentDisplayNames: new Map([['pmem_codex_abcd1234', 'codex-reviewer']])
  });

  expect(messages[0]).toMatchObject({
    id: 'msg_codexreply00',
    meshSessionId: 'mesh_codexdelTeTK',
    deliveryId: 'deliv_01KWEBDErrBa'
  });
});

test('managed MeshAgent persisted replies replace matching live echoes', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [
      {
        id: 'msg_persistedreply',
        authorId: 'pmem_codex_abcd1234',
        authorName: 'GPT 5.6 SOL',
        av: 'GP',
        icon: 'codex',
        kind: 'agent',
        tag: 'Codex',
        time: '',
        text: '收到，这条你处理，我不碰共享工作树、不提交。',
        meshSessionId: 'mesh_codexruntime',
        deliveryId: 'deliv_01KWEBDErrBa',
        orderKey: '2026-07-20T03:00:00.000Z'
      }
    ],
    meshSessions: [],
    liveItems: [
      {
        kind: 'message',
        id: 'msg_livereplyecho',
        role: 'assistant',
        agentName: 'pmem_codex_abcd1234',
        agentDisplayName: 'GPT 5.6 SOL',
        source: 'managed-mesh-agent',
        meshSessionId: 'mesh_codexruntime',
        deliveryId: 'deliv_01KWEBDErrBa',
        parts: [{ type: 'text', text: '收到，这条你处理，我不碰共享工作树、不提交。' }],
        status: 'done',
        seq: '2026-07-20T03:00:00.000Z'
      }
    ],
    liveTools: []
  });

  expect(messages.map(({ id, text }) => [id, text])).toEqual([
    ['msg_persistedreply', '收到，这条你处理，我不碰共享工作树、不提交。']
  ]);
});

test('managed MeshAgent spawn does not project a join or thinking placeholder', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    meshSessions: [],
    liveItems: [
      {
        kind: 'message',
        id: 'msg_stevethi6Vch',
        role: 'assistant',
        agentName: 'pmem_steve',
        source: 'managed-mesh-agent',
        parts: [{ type: 'reasoning', text: 'Thinking' }],
        status: 'streaming',
        seq: '001'
      }
    ],
    liveTools: [
      {
        kind: 'tool',
        id: 'mesh_steve0000000',
        tool: 'mesh-agent:codex',
        input: { agent: 'pmem_steve', provider: 'codex', productIcon: 'codex' },
        status: 'running',
        seq: '002'
      }
    ],
    meshAgentDisplayNames: new Map([['pmem_steve', 'Steve']])
  });

  expect(messages).toEqual([]);
});

test('managed message author snapshot wins over current project member metadata', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    meshSessions: [],
    liveItems: [
      {
        kind: 'message',
        id: 'msg_fablehistory',
        role: 'assistant',
        agentName: 'pmem_claude_fable',
        agentDisplayName: 'Fable',
        source: 'managed-mesh-agent',
        parts: [{ type: 'text', text: 'Historical response' }],
        status: 'done',
        seq: '001'
      }
    ],
    liveTools: [],
    meshAgentDisplayNames: new Map([['pmem_claude_fable', 'Opus']])
  });

  expect(messages).toEqual([
    expect.objectContaining({
      id: 'msg_fablehistory',
      authorId: 'pmem_claude_fable',
      authorName: 'Fable',
      text: 'Historical response'
    })
  ]);
});

test('managed MeshAgent join stays before its first room message when live tool seq uses event ids', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [
      {
        id: 'msg_agentgreqina',
        authorId: 'pmem_codex_a',
        authorName: 'A',
        av: 'A',
        icon: 'codex',
        kind: 'agent',
        tag: 'Codex',
        time: '',
        text: 'A joined and is ready to take project work.',
        orderKey: '2026-07-02T10:00:02.000Z'
      }
    ],
    projectMembers: [
      {
        id: 'pmem_codex_a',
        type: 'mesh-agent',
        name: 'codex',
        instanceId: 'pmem_codex_a',
        displayName: 'A',
        joinedAt: '2026-07-02T10:00:01.000Z'
      }
    ],
    meshSessions: [],
    liveItems: [],
    liveTools: [
      {
        kind: 'tool',
        id: 'mesh_a00000000000',
        tool: 'mesh-agent:codex',
        input: { agent: 'pmem_codex_a', provider: 'codex', productIcon: 'codex' },
        status: 'running',
        seq: 'evt_01KWHJOIN000'
      }
    ],
    meshAgentDisplayNames: new Map([['pmem_codex_a', 'A']])
  });

  expect(messages.map((message) => [message.id, message.text])).toEqual([
    ['project-member-joined:pmem_codex_a', 'joined the project'],
    ['msg_agentgreqina', 'A joined and is ready to take project work.']
  ]);
});

test('managed MeshAgent restart does not move replies from an earlier runtime', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [
      {
        id: 'msg_olduser000000',
        authorId: 'me',
        authorName: 'Operator',
        av: 'ME',
        kind: 'human',
        tag: 'User',
        time: '',
        text: 'Explain the issue',
        orderKey: '2026-07-17T16:33:56.760Z'
      },
      {
        id: 'msg_oldreply00000',
        authorId: 'pmem_claude_a',
        authorName: 'Opus',
        av: 'OP',
        kind: 'agent',
        tag: 'Claude',
        time: '',
        text: 'Here is the explanation',
        meshSessionId: 'mesh_oldruntime000',
        orderKey: '2026-07-17T16:35:12.128Z'
      },
      {
        id: 'msg_newuser000000',
        authorId: 'me',
        authorName: 'Operator',
        av: 'ME',
        kind: 'human',
        tag: 'User',
        time: '',
        text: 'Research the products',
        orderKey: '2026-07-17T17:02:01.987Z'
      }
    ],
    meshSessions: [
      meshSession({
        id: 'mesh_newruntime000',
        agentRuntimeId: 'mesh_newruntime000',
        agentName: 'pmem_claude_a',
        provider: 'claude-code',
        productIcon: 'claude-code',
        startedAt: '2026-07-17T17:02:02.223Z',
        updatedAt: '2026-07-17T17:05:55.815Z'
      })
    ],
    liveItems: [],
    liveTools: []
  });

  expect(messages.map(({ id, orderKey }) => [id, orderKey])).toEqual([
    ['msg_olduser000000', '2026-07-17T16:33:56.760Z'],
    ['msg_oldreply00000', '2026-07-17T16:35:12.128Z'],
    ['msg_newuser000000', '2026-07-17T17:02:01.987Z']
  ]);
});

test('MeshAgent streams prefer live activity output over persisted snapshot', () => {
  const stream = firstMeshAgentStream(
    __workplaceProjectMessageTest.buildMeshAgentStreams(
      [meshSession({ outputSnapshot: 'old snapshot' })],
      [
        {
          id: 'mesh_01KWGEMIprD4',
          av: 'GE',
          tool: 'mesh-agent:gemini',
          detail: 'native cli activity',
          output: 'live output',
          status: 'running'
        }
      ]
    )
  );

  expect(stream).toMatchObject({
    id: 'mesh_01KWGEMIprD4',
    agentName: 'gemini',
    provider: 'gemini',
    tag: 'Gemini',
    output: 'live output',
    items: [messageCard('mesh_01KWGEMIprD4:0', 'live output', 'gemini')],
    status: 'running'
  });
});

test('MeshAgent streams carry their own transcript target for observation/history requests', () => {
  const stream = firstMeshAgentStream(
    __workplaceProjectMessageTest.buildMeshAgentStreams([meshSession({ sessionId: 'ses_01KWOWNER9zQ2' })], [])
  );

  expect(stream.transcriptTargetId).toBe('ses_01KWOWNER9zQ2');
});

test('MeshAgent durable sessions expose status without embedding provider output', () => {
  const stream = firstMeshAgentStream(
    __workplaceProjectMessageTest.buildMeshAgentStreams(
      [meshSession({ outputSnapshot: 'previous turn output', state: 'running' })],
      []
    )
  );

  expect(stream).toMatchObject({
    id: 'mesh_01KWGEMIprD4',
    agentName: 'gemini',
    output: '',
    status: 'ok',
    items: []
  });
});

test('MeshAgent live activity streams keep the managed agent identity', () => {
  const stream = firstMeshAgentStream(
    __workplaceProjectMessageTest.buildMeshAgentStreams(
      [],
      [
        {
          id: 'mesh_livecodex000',
          av: 'CO',
          agentName: 'codex',
          tool: 'mesh-agent:codex',
          detail: 'mesh-agent:codex',
          output: 'thinking about the project message',
          status: 'running'
        }
      ]
    )
  );

  expect(stream).toMatchObject({
    id: 'mesh_livecodex000',
    agentName: 'codex',
    status: 'running',
    items: [messageCard('mesh_livecodex000:0', 'thinking about the project message', 'codex')]
  });
});

test('managed MeshAgent streams retain template agent names for host usage queries', () => {
  const stream = firstMeshAgentStream(
    __workplaceProjectMessageTest.buildMeshAgentStreams(
      [
        meshSession({
          id: 'mesh_codexrev9zCF',
          agentName: 'pmem_codex_reviewer',
          provider: 'codex',
          productIcon: 'codex'
        })
      ],
      [],
      new Map([['pmem_codex_reviewer', 'codex']])
    )
  );

  expect(stream).toMatchObject({
    id: 'mesh_codexrev9zCF',
    agentName: 'pmem_codex_reviewer',
    templateAgentName: 'codex'
  });
});

test('MeshAgent structured result output is projected as readable observation items', () => {
  const stream = firstMeshAgentStream(
    __workplaceProjectMessageTest.buildMeshAgentStreams(
      [],
      [
        {
          id: 'mesh_structuryOpn',
          av: 'CO',
          agentName: 'codex',
          tool: 'mesh-agent:codex',
          detail: 'mesh-agent:codex',
          output: JSON.stringify({
            type: 'result',
            subtype: 'success',
            result: '仍被拦截，无法发出。卡点未变：`monad project` 命令需要你批准。',
            permission_denials: [
              {
                tool_name: 'Bash',
                tool_input: {
                  command: 'monad project post "你好！"',
                  description: 'Post greeting to project channel'
                }
              }
            ]
          }),
          status: 'running'
        }
      ]
    )
  );

  expect(observationFields(stream.items)).toEqual([
    { id: 'mesh_structuryOpn:result', text: '仍被拦截，无法发出。卡点未变：`monad project` 命令需要你批准。' },
    { id: 'mesh_structuryOpn:denial:0', text: 'Permission blocked Bash: monad project post "你好！"' }
  ]);
});

test('MeshAgent stream-json events are projected as readable observation items', () => {
  const output = [
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'I can help.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash' }
        ]
      }
    }),
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Streaming text.' } }
    }),
    JSON.stringify({ type: 'tool_result', id: 'toolu_1', output: 'command output' }),
    JSON.stringify({ type: 'result', response: 'Done.' })
  ].join('\n');

  const stream = firstMeshAgentStream(
    __workplaceProjectMessageTest.buildMeshAgentStreams(
      [],
      [
        {
          id: 'mesh_streamevents',
          av: 'CO',
          agentName: 'claude-code',
          tool: 'mesh-agent:claude-code',
          detail: 'mesh-agent:claude-code',
          output,
          status: 'running'
        }
      ]
    )
  );

  expect(observationFields(stream.items)).toEqual([
    { id: 'mesh_streamevents:json:0:message:0', text: 'I can help.' },
    { id: 'mesh_streamevents:json:0:tool:1', text: 'Tool call Bash' },
    { id: 'mesh_streamevents:json:1:delta', text: 'Streaming text.' },
    { id: 'mesh_streamevents:json:2:tool-result', text: 'command output' },
    { id: 'mesh_streamevents:json:3:result', text: 'Done.' }
  ]);
});

test('MeshAgent projection ignores startup prose before stream-json objects', () => {
  const output = [
    'started claude-code in /Users/test/.monad/workplace-agents/project/claude-code',
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session' }),
    JSON.stringify({ type: 'result', result: 'Need approval before posting.' })
  ].join('\n');

  const stream = firstMeshAgentStream(
    __workplaceProjectMessageTest.buildMeshAgentStreams(
      [],
      [
        {
          id: 'mesh_mixedclaude0',
          av: 'CL',
          agentName: 'claude-code',
          tool: 'mesh-agent:claude-code',
          detail: 'mesh-agent:claude-code',
          output,
          status: 'running'
        }
      ]
    )
  );

  // The `system` init notice now surfaces as a `system` kind (session lifecycle notices, e.g. login,
  // must stay visible in backfilled history); the result survives as a turn-end with its final text.
  expect(observationFields(stream.items)).toEqual([
    { id: 'mesh_mixedclaude0:json:0:system', text: 'init' },
    { id: 'mesh_mixedclaude0:json:1:result', text: 'Need approval before posting.' }
  ]);
});

test('MeshAgent app-server JSON-RPC output is projected as readable observation items', () => {
  const output = [
    JSON.stringify({
      method: 'thread/started',
      params: {
        thread: {
          id: '019f1f3a-5e8d-7260-a35e-c755a13bfde2',
          cwd: '/Users/test/project/.dev/.monad/workplace-agents/project/test'
        }
      }
    }),
    JSON.stringify({
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: '019f1f3a-5e8d-7260-a35e-c755a13bfde2',
        name: 'node_repl',
        status: 'starting',
        error: null
      }
    })
  ].join('\n');

  const stream = firstMeshAgentStream(
    __workplaceProjectMessageTest.buildMeshAgentStreams(
      [],
      [
        {
          id: 'mesh_appserveQWB9',
          av: 'CO',
          agentName: 'test',
          tool: 'mesh-agent:codex',
          detail: 'mesh-agent:codex',
          output,
          status: 'running'
        }
      ]
    )
  );

  // The `thread/started` system notice now surfaces as a `system` kind; the mcp status is a tool
  // event and survives.
  expect(observationFields(stream.items)).toEqual([
    {
      id: 'mesh_appserveQWB9:json:0:thread-started',
      text: 'Thread started in /Users/test/project/.dev/.monad/workplace-agents/project/test'
    },
    { id: 'mesh_appserveQWB9:json:1:mcp-status', text: 'node_repl starting' }
  ]);
});

test('MeshAgent follow streams do not restore removed terminal snapshots', () => {
  const stream = firstMeshAgentStream(
    __workplaceProjectMessageTest.buildMeshAgentStreams(
      [meshSession({ outputSnapshot: '\\x1b[38;2;255;193;7mraw terminal output' })],
      []
    )
  );

  expect(stream).toMatchObject({
    id: 'mesh_01KWGEMIprD4',
    output: '',
    items: []
  });
});

test('typed idle suspension uses the configured project member identity', () => {
  const avatarUrl = __workplaceProjectMessageTest.entityAvatarUrl('mesh-agent-instance:reviewer');
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    projectMembers: [
      {
        id: 'pmem_codex_reviewer',
        type: 'mesh-agent',
        name: 'codex',
        displayName: 'Reviewer'
      }
    ],
    meshSessions: [],
    liveItems: [
      {
        kind: 'system',
        id: 'mesh-agent-idle-suspended:pmem_codex_reviewer',
        text: 'fell asleep.',
        event: {
          agentId: 'pmem_codex_reviewer',
          agentName: 'Reviewer',
          type: 'idle_suspended',
          payload: { meshSessionId: 'mesh_codexreviewer', idleTimeoutMs: 300_000 }
        },
        seq: 'evt_idle_suspended'
      }
    ],
    liveTools: [],
    meshAgentDisplayNames: new Map([['pmem_codex_reviewer', 'Review Lead']]),
    meshAgentAvatarSeeds: new Map([['Review Lead', 'mesh-agent-instance:reviewer']]),
    meshAgentIcons: new Map([['pmem_codex_reviewer', 'codex']]),
    meshAgentTags: new Map([['pmem_codex_reviewer', 'Codex']])
  });

  expect(messages).toEqual([
    {
      id: 'mesh-agent-idle-suspended:pmem_codex_reviewer',
      authorId: 'pmem_codex_reviewer',
      authorName: 'Review Lead',
      av: 'RL',
      icon: 'codex',
      avatarUrl,
      kind: 'system',
      tag: 'Codex',
      time: '',
      text: 'fell asleep.',
      agentChip: {
        id: 'pmem_codex_reviewer',
        name: 'Review Lead',
        icon: 'codex',
        avatarUrl,
        tag: 'Codex'
      },
      orderKey: 'evt_idle_suspended'
    }
  ]);
});

test('typed idle resumption keeps the configured project member identity', () => {
  const avatarUrl = __workplaceProjectMessageTest.entityAvatarUrl('mesh-agent-instance:reviewer');
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    projectMembers: [
      {
        id: 'pmem_codex_reviewer',
        type: 'mesh-agent',
        name: 'codex',
        displayName: 'Reviewer'
      }
    ],
    meshSessions: [],
    liveItems: [
      {
        kind: 'system',
        id: 'mesh-agent-idle-resumed:pmem_codex_reviewer',
        text: 'woke up.',
        event: {
          agentId: 'pmem_codex_reviewer',
          agentName: 'Reviewer',
          type: 'idle_resumed',
          payload: { meshSessionId: 'mesh_codexreviewer' }
        },
        seq: 'evt_idle_resumed'
      }
    ],
    liveTools: [],
    meshAgentDisplayNames: new Map([['pmem_codex_reviewer', 'Review Lead']]),
    meshAgentAvatarSeeds: new Map([['Review Lead', 'mesh-agent-instance:reviewer']]),
    meshAgentIcons: new Map([['pmem_codex_reviewer', 'codex']]),
    meshAgentTags: new Map([['pmem_codex_reviewer', 'Codex']])
  });

  expect(messages).toEqual([
    {
      id: 'mesh-agent-idle-resumed:pmem_codex_reviewer',
      authorId: 'pmem_codex_reviewer',
      authorName: 'Review Lead',
      av: 'RL',
      icon: 'codex',
      avatarUrl,
      kind: 'system',
      tag: 'Codex',
      time: '',
      text: 'woke up.',
      agentChip: {
        id: 'pmem_codex_reviewer',
        name: 'Review Lead',
        icon: 'codex',
        avatarUrl,
        tag: 'Codex'
      },
      orderKey: 'evt_idle_resumed'
    }
  ]);
});

test('typed lifecycle event falls back to its actor name and generated identity', () => {
  const avatarUrl = __workplaceProjectMessageTest.entityAvatarUrl('mesh-agent:Monad');
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    meshSessions: [],
    liveItems: [
      {
        kind: 'system',
        id: 'mesh-agent-idle-suspended:pmem_codex_unconfigured',
        text: 'fell asleep.',
        event: {
          agentId: 'pmem_codex_unconfigured',
          agentName: 'Monad',
          type: 'idle_suspended',
          payload: { meshSessionId: 'mesh_codexunknown', idleTimeoutMs: 300_000 }
        },
        seq: 'evt_idle_unconfigured'
      }
    ],
    liveTools: []
  });

  expect(messages).toEqual([
    {
      id: 'mesh-agent-idle-suspended:pmem_codex_unconfigured',
      authorId: 'pmem_codex_unconfigured',
      authorName: 'Monad',
      av: 'MO',
      icon: 'monad',
      avatarUrl,
      kind: 'system',
      tag: 'CLI',
      time: '',
      text: 'fell asleep.',
      agentChip: {
        id: 'pmem_codex_unconfigured',
        name: 'Monad',
        icon: 'monad',
        avatarUrl,
        tag: 'CLI'
      },
      orderKey: 'evt_idle_unconfigured'
    }
  ]);
});

test('MeshAgent resume failure without a typed event keeps the legacy ID fallback', () => {
  const avatarUrl = __workplaceProjectMessageTest.entityAvatarUrl('mesh-agent-resume:codex');
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    meshSessions: [],
    liveItems: [
      {
        kind: 'system',
        id: 'mesh-agent-resume-failed:codex',
        text: 'Codex resume failed for provider session codex-thread-stale; cold started a new runtime.',
        level: 'warn',
        seq: 'evt_resumefailed'
      }
    ],
    liveTools: [],
    showDeveloperOnlyMessages: false
  });

  expect(messages).toEqual([
    {
      id: 'mesh-agent-resume-failed:codex',
      authorId: 'codex',
      authorName: 'codex',
      av: 'C',
      icon: undefined,
      avatarUrl,
      kind: 'system',
      tag: 'CLI',
      time: '',
      text: 'Codex resume failed for provider session codex-thread-stale; cold started a new runtime.',
      orderKey: 'evt_resumefailed'
    }
  ]);
});

test('MeshAgent project member presence treats spawned runtime as online until it generates', () => {
  expect(
    __workplaceProjectMessageTest.meshAgentMemberPresence({
      agentName: 'gemini',
      enabled: true,
      meshSessions: [],
      liveTools: []
    })
  ).toBe('online');

  expect(
    __workplaceProjectMessageTest.meshAgentMemberPresence({
      agentName: 'gemini',
      enabled: true,
      meshSessions: [],
      liveTools: [
        {
          id: 'tool_observation',
          kind: 'tool',
          tool: 'mesh-agent:gemini',
          input: { agent: 'gemini' },
          output: 'provider runtime output',
          status: 'running',
          seq: '002'
        } as never
      ]
    })
  ).toBe('online');

  expect(
    __workplaceProjectMessageTest.meshAgentMemberPresence({
      agentName: 'gemini',
      enabled: true,
      meshSessions: [],
      liveTools: [
        {
          id: 'tool_login',
          kind: 'tool',
          tool: 'mesh-agent:gemini',
          input: { agent: 'gemini' },
          output: 'connection_required: sign in',
          status: 'running',
          seq: '003'
        } as never
      ]
    })
  ).toBe('needs-login');

  expect(
    __workplaceProjectMessageTest.meshAgentMemberPresence({
      agentName: 'gemini',
      enabled: true,
      meshSessions: [meshSession({ state: 'failed', outputSnapshot: 'process exited 1' })],
      liveTools: []
    })
  ).toBe('failed');

  expect(
    __workplaceProjectMessageTest.meshAgentMemberPresence({
      agentName: 'gemini',
      enabled: true,
      meshSessions: [meshSession({ state: 'stopped' })],
      liveTools: []
    })
  ).toBe('online');
});

test('MeshAgent presence ignores login phrases inside Claude tool results', () => {
  const session = meshSession({
    agentName: 'pmem_claude',
    provider: 'claude-code',
    state: 'stopped',
    outputSnapshot: JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: "installHint: 'Install OpenClaw, then sign in with openclaw models auth login.'"
          }
        ]
      }
    })
  });

  expect(
    __workplaceProjectMessageTest.meshAgentMemberPresence({
      agentName: 'pmem_claude',
      enabled: true,
      meshSessions: [session],
      liveTools: []
    })
  ).toBe('online');
});

test('MeshAgent presence does not infer authentication from removed session output', () => {
  const session = meshSession({
    agentName: 'pmem_claude',
    provider: 'claude-code',
    state: 'stopped',
    outputSnapshot: JSON.stringify({
      type: 'system',
      subtype: 'connection_required',
      error: 'Please sign in'
    })
  });

  expect(
    __workplaceProjectMessageTest.meshAgentMemberPresence({
      agentName: 'pmem_claude',
      enabled: true,
      meshSessions: [session],
      liveTools: []
    })
  ).toBe('online');
});

test('MeshAgent project member presence treats lifecycle tools as stand-by availability', () => {
  expect(
    __workplaceProjectMessageTest.meshAgentMemberPresence({
      agentName: 'gemini',
      enabled: true,
      meshSessions: [],
      liveTools: [
        {
          id: 'mesh_session00000',
          kind: 'tool',
          tool: 'mesh-agent:gemini',
          input: { agent: 'gemini' },
          status: 'running',
          seq: '002'
        } as never
      ]
    })
  ).toBe('online');
});

test('MeshAgent project member presence treats streaming managed messages as active generation', () => {
  expect(
    __workplaceProjectMessageTest.meshAgentMemberPresence({
      agentName: 'gemini',
      enabled: true,
      meshSessions: [],
      liveTools: [],
      activeAgentNames: new Set(['gemini'])
    })
  ).toBe('working');
});

test('MeshAgent project member presence shows running sessions with provider approvals as working', () => {
  expect(
    __workplaceProjectMessageTest.meshAgentMemberPresence({
      agentName: 'gemini',
      enabled: true,
      meshSessions: [
        meshSession({
          pendingApprovalCount: 1
        } as Partial<MeshSessionView> & { pendingApprovalCount: number })
      ],
      liveTools: []
    })
  ).toBe('working');
});

test('MeshAgent project member presence is scoped by managed member instance id', () => {
  expect(
    __workplaceProjectMessageTest.meshAgentMemberPresence({
      agentName: 'pmem_codex_reviewer',
      enabled: true,
      meshSessions: [],
      liveTools: [
        {
          id: 'tool_other_codex',
          kind: 'tool',
          tool: 'mesh-agent:codex',
          input: { agent: 'pmem_codex_writer' },
          status: 'running',
          seq: '002'
        } as never
      ]
    })
  ).toBe('online');

  expect(
    __workplaceProjectMessageTest.meshAgentMemberPresence({
      agentName: 'pmem_codex_reviewer',
      enabled: true,
      meshSessions: [],
      liveTools: [],
      activeAgentNames: new Set(['pmem_codex_reviewer'])
    })
  ).toBe('working');
});

test('MeshAgent project members default to managed project runtime', () => {
  expect(__workplaceProjectMessageTest.defaultProjectMemberSettings('mesh-agent', {})).toEqual({
    managedProjectAgent: true
  });
});

test('MeshAgent project members derive template and instance identity from the template itself', () => {
  const [member] = __workplaceProjectMessageTest.parseProjectMembers([
    {
      id: 'pmem_codex_reviewer',
      type: 'mesh-agent',
      name: 'codex',
      displayName: 'codex-reviewer',
      settings: {
        managedProjectAgent: true,
        modelId: 'gpt-5.5',
        reasoningEffort: 'high',
        speed: 'fast',
        customPrompt: 'Review only correctness issues.'
      }
    }
  ]);

  expect(member).toMatchObject({
    id: 'pmem_codex_reviewer',
    type: 'mesh-agent',
    name: 'codex',
    templateName: 'codex',
    displayName: 'codex-reviewer',
    instanceId: 'pmem_codex_reviewer',
    settings: {
      modelId: 'gpt-5.5',
      reasoningEffort: 'high',
      speed: 'fast',
      customPrompt: 'Review only correctness issues.'
    }
  });
});

test('MeshAgent product display names use official client names', () => {
  expect(__workplaceProjectMessageTest.meshAgentProductDisplayName('codex', 'codex', 'codex')).toBe('OpenAI Codex');
  expect(__workplaceProjectMessageTest.meshAgentProductDisplayName('claude-code', 'claude-code', 'claude-code')).toBe(
    'Claude Code'
  );
  expect(__workplaceProjectMessageTest.meshAgentProductDisplayName('gemini', 'gemini', 'gemini')).toBe('Gemini CLI');
  expect(__workplaceProjectMessageTest.meshAgentProductDisplayName('qwen', 'qwen', 'qwen')).toBe('Qwen Code');
});

test('MeshAgent project member rename preserves runtime identity fields', () => {
  const member = __workplaceProjectMessageTest.renameMeshAgentProjectMemberDisplayName(
    {
      id: 'pmem_codex_reviewer',
      type: 'mesh-agent',
      name: 'codex-reviewer',
      templateName: 'codex',
      displayName: 'Reviewer',
      instanceId: 'pmem_codex_reviewer',
      settings: { managedProjectAgent: true }
    },
    'Renamed reviewer'
  );

  expect(member).toMatchObject({
    id: 'pmem_codex_reviewer',
    type: 'mesh-agent',
    name: 'codex-reviewer',
    templateName: 'codex',
    displayName: 'Renamed reviewer',
    instanceId: 'pmem_codex_reviewer'
  });
});

test('generated avatars use local cache URLs keyed by stable seeds', () => {
  const url = __workplaceProjectMessageTest.entityAvatarUrl('Felix754865');
  expect(url).toBe(
    `/api/avatar-cache/${__workplaceProjectMessageTest.avatarCacheKey('Felix754865')}.svg?seed=Felix754865&style=notionists`
  );
  expect(__workplaceProjectMessageTest.entityAvatarWriteUrl('Felix754865')).toBe(url);
  expect(__workplaceProjectMessageTest.avatarCacheKey('user:Operator')).not.toBe(
    __workplaceProjectMessageTest.avatarCacheKey('user:Renamed')
  );
  expect(
    __workplaceProjectMessageTest.projectMemberJoinMessageView(
      {
        id: 'codex-reviewer',
        type: 'mesh-agent',
        name: 'codex-reviewer',
        joinedAt: '2026-06-29T10:00:00.000Z'
      },
      'codex-reviewer'
    )
  ).toMatchObject({
    avatarUrl: __workplaceProjectMessageTest.entityAvatarUrl('mesh-agent:codex-reviewer'),
    agentChip: {
      avatarUrl: __workplaceProjectMessageTest.entityAvatarUrl('mesh-agent:codex-reviewer')
    }
  });
});

test('MeshAgent system and assistant messages share the same instance avatar url', () => {
  const avatarUrl = __workplaceProjectMessageTest.entityAvatarUrl('mesh-agent-instance:reviewer');
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    projectMembers: [
      {
        id: 'pmem_codex_reviewer',
        type: 'mesh-agent',
        name: 'codex',
        instanceId: 'pmem_codex_reviewer',
        displayName: 'Reviewer',
        joinedAt: '2026-06-29T10:00:00.000Z'
      }
    ],
    meshSessions: [meshSession({ agentName: 'pmem_codex_reviewer', productIcon: 'codex', provider: 'codex' })],
    liveItems: [
      {
        id: 'msg_reply0000000',
        kind: 'message',
        role: 'assistant',
        agentName: 'pmem_codex_reviewer',
        source: 'managed-mesh-agent',
        parts: [{ type: 'text', text: 'Done' }],
        status: 'complete',
        seq: '002'
      }
    ] as never,
    liveTools: [],
    meshAgentDisplayNames: new Map([['pmem_codex_reviewer', 'Reviewer']]),
    meshAgentAvatarSeeds: new Map([['Reviewer', 'mesh-agent-instance:reviewer']])
  });

  const joined = messages.find((message) => message.id.startsWith('project-member-joined:'));
  const reply = messages.find((message) => message.id === 'msg_reply0000000');

  expect(joined?.avatarUrl).toBe(avatarUrl);
  expect(joined?.agentChip?.avatarUrl).toBe(avatarUrl);
  expect(reply?.avatarUrl).toBe(avatarUrl);
});

test('MeshAgent assistant messages keep provider icon when display name is custom', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    meshSessions: [meshSession({ agentName: 'pmem_codex_reviewer', productIcon: 'codex', provider: 'codex' })],
    liveItems: [
      {
        id: 'msg_reply0000000',
        kind: 'message',
        role: 'assistant',
        agentName: 'pmem_codex_reviewer',
        source: 'managed-mesh-agent',
        parts: [{ type: 'text', text: 'Done' }],
        status: 'complete',
        seq: '002'
      }
    ] as never,
    liveTools: [],
    meshAgentDisplayNames: new Map([['pmem_codex_reviewer', 'Lily']]),
    meshAgentIcons: new Map([['pmem_codex_reviewer', 'codex']]),
    meshAgentTags: new Map([['pmem_codex_reviewer', 'Codex']])
  });

  expect(messages.find((message) => message.id === 'msg_reply0000000')).toMatchObject({
    authorName: 'Lily',
    icon: 'codex',
    tag: 'Codex'
  });
});

test('workplace messages sort oldest first', () => {
  const messages: Message[] = [
    {
      id: 'newer',
      authorId: 'a',
      authorName: 'a',
      av: 'A',
      kind: 'agent',
      tag: 'AI',
      time: '',
      text: 'new',
      orderKey: '002'
    },
    {
      id: 'older',
      authorId: 'a',
      authorName: 'a',
      av: 'A',
      kind: 'agent',
      tag: 'AI',
      time: '',
      text: 'old',
      orderKey: '001'
    }
  ];

  expect(__workplaceProjectMessageTest.sortMessagesOldestFirst(messages).map((message) => message.id)).toEqual([
    'older',
    'newer'
  ]);
});
