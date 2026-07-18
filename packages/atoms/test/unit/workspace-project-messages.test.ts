import type { ExternalAgentSessionView } from '@monad/protocol';
import type { Message } from '../../src/workspace-experiences/experience/types.ts';

import { expect, test } from 'bun:test';

import { builtinAgentAdapters } from '../../src/agent-adapters/index.ts';
import { __workplaceProjectMessageTest } from '../../src/workspace-experiences/chat-room/utils/projection.ts';
import { configureExternalAgentObservationAdapterResolver } from '../../src/workspace-experiences/experience/external-agent-observation/external-agent-observation.ts';
import { projectMemberParticipants } from '../../src/workspace-experiences/experience/project-projection.ts';

configureExternalAgentObservationAdapterResolver((provider) =>
  builtinAgentAdapters.find((adapter) => adapter.provider === provider)
);

const externalAgentSession = (overrides: Partial<ExternalAgentSessionView> = {}): ExternalAgentSessionView => ({
  id: 'exa_01KWGEMIprD4',
  sessionId: 'ses_01KWPROJ2tDh',
  agentName: 'gemini',
  provider: 'gemini',
  productIcon: 'gemini',
  workingPath: '/Users/test/Projects/monad',
  launchMode: 'pty',
  approvalOwnership: 'provider-owned',
  runtimeRole: 'managed-project-agent',
  agentRuntimeId: 'exa_01KWGEMIprD4',
  lastDeliveredSeq: 0,
  lastVisibleSeq: 0,
  state: 'running',
  pid: 1234,
  providerSessionRef: null,
  outputSnapshot: '',
  exitCode: null,
  startedAt: '2026-06-29T10:00:00.000Z',
  updatedAt: '2026-06-29T10:00:00.000Z',
  exitedAt: null,
  ...overrides,
  pendingApprovalCount: overrides.pendingApprovalCount ?? 0
});

const observationFields = (
  items: NonNullable<ReturnType<typeof __workplaceProjectMessageTest.buildExternalAgentStreams>[number]>['items']
) => items.map(({ id, text }) => ({ id, text }));

function firstExternalAgentStream(streams: ReturnType<typeof __workplaceProjectMessageTest.buildExternalAgentStreams>) {
  const stream = streams[0];
  if (!stream) throw new Error('expected an external agent stream');
  return stream;
}

test('external agent member invitations project to durable chat messages', () => {
  const [message] = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    projectMembers: [
      {
        id: 'pmem_gemini',
        type: 'external-agent',
        name: 'gemini',
        instanceId: 'pmem_gemini',
        joinedAt: '2026-06-29T10:00:00.000Z'
      }
    ],
    externalAgentSessions: [],
    liveItems: [],
    liveTools: [],
    externalAgentIcons: new Map([['pmem_gemini', 'gemini']]),
    externalAgentTags: new Map([['pmem_gemini', 'Gemini']])
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

test('external agent developer messages expose only a follow entry', () => {
  const message = __workplaceProjectMessageTest.externalAgentSessionDeveloperMessage(externalAgentSession());

  expect(message).toMatchObject({
    id: 'external-agent-session-developer:exa_01KWGEMIprD4',
    kind: 'developer',
    tag: 'DEV',
    text: 'CLI stream available',
    externalAgentSessionId: 'exa_01KWGEMIprD4',
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
        type: 'external-agent',
        name: 'gemini',
        instanceId: 'pmem_gemini_reviewer',
        displayName: 'Reviewer',
        joinedAt: '2026-06-29T09:59:00.000Z'
      }
    ],
    externalAgentSessions: [
      externalAgentSession({
        id: 'exa_oldruntime001',
        agentName: 'pmem_gemini_reviewer',
        startedAt: '2026-06-29T10:00:00.000Z'
      }),
      externalAgentSession({
        id: 'exa_newruntime001',
        agentName: 'pmem_gemini_reviewer',
        startedAt: '2026-06-29T11:00:00.000Z'
      })
    ],
    liveItems: [],
    liveTools: [],
    externalAgentDisplayNames: new Map([['pmem_gemini_reviewer', 'Reviewer']]),
    externalAgentIcons: new Map([['pmem_gemini_reviewer', 'gemini']]),
    externalAgentTags: new Map([['pmem_gemini_reviewer', 'Gemini']])
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
    externalAgentSessions: [externalAgentSession()],
    liveItems: [],
    liveTools: [
      {
        id: 'exa_live00000000',
        kind: 'tool',
        tool: 'external-agent:gemini',
        input: { agent: 'gemini', provider: 'gemini', productIcon: 'gemini' },
        status: 'running',
        seq: '002'
      } as never
    ]
  });

  expect(messages.map((message) => message.text)).toEqual([]);
});

test('Claude server errors project as agent-scoped system messages', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    externalAgentSessions: [
      externalAgentSession({
        id: 'exa_claudeerror0',
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
    externalAgentDisplayNames: new Map([['pmem_claude_1234', 'Steve']])
  });

  expect(messages.map((message) => [message.id, message.text])).toEqual([
    ['external-agent-session-error:exa_claudeerror0:exa_claudeerror0:result', 'encountered an error']
  ]);
  expect(messages[0]).toMatchObject({
    authorId: 'pmem_claude_1234',
    authorName: 'Steve',
    kind: 'system',
    tag: 'Claude',
    externalAgentSessionId: 'exa_claudeerror0',
    systemTone: 'error',
    systemDetail: 'API Error: overloaded_error. Claude Code is currently overloaded.',
    agentChip: {
      id: 'pmem_claude_1234',
      name: 'Steve',
      icon: 'claude-code',
      tag: 'Claude'
    }
  });
});

test('external agent developer messages are projected only when explicitly enabled', () => {
  const hidden = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    externalAgentSessions: [],
    liveItems: [],
    liveTools: [
      {
        id: 'exa_live00000000',
        kind: 'tool',
        tool: 'external-agent:codex',
        input: { agent: 'codex', provider: 'codex', productIcon: 'codex' },
        output: 'raw terminal output',
        status: 'running',
        seq: '002'
      } as never
    ]
  });
  const visible = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    externalAgentSessions: [],
    liveItems: [],
    liveTools: [
      {
        id: 'exa_live00000000',
        kind: 'tool',
        tool: 'external-agent:codex',
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

test('external agent runtime lifecycle does not project member joins', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    externalAgentSessions: [
      externalAgentSession({
        id: 'exa_first0000000',
        agentName: 'codex',
        provider: 'codex',
        productIcon: 'codex',
        state: 'stopped',
        startedAt: '2026-06-29T10:00:00.000Z',
        updatedAt: '2026-06-29T10:01:00.000Z',
        exitedAt: '2026-06-29T10:01:00.000Z'
      }),
      externalAgentSession({
        id: 'exa_second000000',
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

test('managed external agent timeline messages use display names instead of runtime ids', () => {
  const displayNames = new Map([['pmem_codex_abcd1234', 'codex-reviewer']]);
  const avatarSeeds = new Map([['codex-reviewer', 'external-agent:codex-reviewer']]);
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    externalAgentSessions: [
      externalAgentSession({
        id: 'exa_display00000',
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
        source: 'managed-external-agent',
        parts: [{ type: 'text', text: 'Ready.' }],
        status: 'done',
        seq: '2026-06-29T10:00:01.000Z'
      }
    ],
    liveTools: [],
    externalAgentAvatarSeeds: avatarSeeds,
    externalAgentDisplayNames: displayNames,
    showDeveloperOnlyMessages: false
  });

  expect(messages.map((message) => message.authorName)).toEqual(['codex-reviewer']);
  expect(messages.map((message) => message.authorId)).toEqual(['pmem_codex_abcd1234']);
});

test('managed external agent reasoning-only streaming messages stay off the transcript wall', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    externalAgentSessions: [],
    liveItems: [
      {
        kind: 'message',
        id: 'msg_codexthi658B',
        role: 'assistant',
        agentName: 'pmem_codex_abcd1234',
        source: 'managed-external-agent',
        parts: [{ type: 'reasoning', text: 'Thinking' }],
        status: 'streaming',
        seq: '002'
      }
    ],
    liveTools: [],
    externalAgentDisplayNames: new Map([['pmem_codex_abcd1234', 'codex-reviewer']])
  });
  expect(messages).toEqual([]);
});

test('managed external agent terminal reasoning-only messages stay off the transcript wall', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    externalAgentSessions: [],
    liveItems: [
      {
        kind: 'message',
        id: 'msg_codexorpsSFT',
        role: 'assistant',
        agentName: 'pmem_codex_abcd1234',
        source: 'managed-external-agent',
        parts: [{ type: 'reasoning', text: 'Thinking' }],
        status: 'error',
        seq: '002'
      }
    ],
    liveTools: [],
    externalAgentDisplayNames: new Map([['pmem_codex_abcd1234', 'codex-reviewer']])
  });
  expect(messages).toEqual([]);
});

test('external agent live start exposes developer follow without projecting a join', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    externalAgentSessions: [],
    liveItems: [],
    liveTools: [
      {
        id: 'exa_live00000000',
        kind: 'tool',
        tool: 'external-agent:claude-code',
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
    id: 'external-agent-session-developer:exa_live00000000',
    text: 'CLI stream available',
    externalAgentSessionId: 'exa_live00000000'
  });
});

test('external agent live starts do not project member joins', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    externalAgentSessions: [],
    liveItems: [],
    liveTools: [
      {
        id: 'exa_first0000000',
        kind: 'tool',
        tool: 'external-agent:codex',
        input: { agent: 'pmem_codex_a', provider: 'codex', productIcon: 'codex' },
        status: 'running',
        seq: '001'
      } as never,
      {
        id: 'exa_second000000',
        kind: 'tool',
        tool: 'external-agent:codex',
        input: { agent: 'pmem_codex_a', provider: 'codex', productIcon: 'codex' },
        status: 'running',
        seq: '002'
      } as never
    ],
    externalAgentDisplayNames: new Map([['pmem_codex_a', 'A']])
  });

  expect(messages).toEqual([]);
});

test('managed external agent reasoning-only fanout does not project a system divider', () => {
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
    externalAgentSessions: [],
    liveItems: [
      {
        kind: 'message',
        id: 'msg_codexthi658B',
        role: 'assistant',
        agentName: 'codex',
        source: 'managed-external-agent',
        parts: [{ type: 'reasoning', text: 'Thinking' }],
        status: 'streaming',
        seq: '002'
      },
      {
        kind: 'message',
        id: 'msg_claudethDTNA',
        role: 'assistant',
        agentName: 'claude-code',
        source: 'managed-external-agent',
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

test('managed external agent finished replies render without a thinking placeholder', () => {
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
    externalAgentSessions: [],
    liveItems: [
      {
        kind: 'message',
        id: 'msg_codexreply00',
        role: 'assistant',
        agentName: 'codex',
        source: 'managed-external-agent',
        parts: [{ type: 'text', text: 'Done.' }],
        status: 'done',
        seq: '002'
      },
      {
        kind: 'message',
        id: 'msg_claudethDTNA',
        role: 'assistant',
        agentName: 'claude-code',
        source: 'managed-external-agent',
        parts: [{ type: 'reasoning', text: 'Thinking' }],
        status: 'streaming',
        seq: '003'
      }
    ],
    liveTools: []
  });

  expect(messages.map((message) => message.id)).toEqual(['msg_user00000000', 'msg_codexreply00']);
});

test('managed external agent finished replies retain delivery observation pointers', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    externalAgentSessions: [],
    liveItems: [
      {
        kind: 'message',
        id: 'msg_codexreply00',
        role: 'assistant',
        agentName: 'pmem_codex_abcd1234',
        source: 'managed-external-agent',
        externalAgentSessionId: 'exa_codexdelTeTK',
        deliveryId: 'deliv_01KWEBDErrBa',
        parts: [{ type: 'text', text: 'Done.' }],
        status: 'done',
        seq: '2026-06-29T10:00:01.000Z'
      }
    ],
    liveTools: [],
    externalAgentDisplayNames: new Map([['pmem_codex_abcd1234', 'codex-reviewer']])
  });

  expect(messages[0]).toMatchObject({
    id: 'msg_codexreply00',
    externalAgentSessionId: 'exa_codexdelTeTK',
    deliveryId: 'deliv_01KWEBDErrBa'
  });
});

test('managed external agent spawn does not project a join or thinking placeholder', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    externalAgentSessions: [],
    liveItems: [
      {
        kind: 'message',
        id: 'msg_stevethi6Vch',
        role: 'assistant',
        agentName: 'pmem_steve',
        source: 'managed-external-agent',
        parts: [{ type: 'reasoning', text: 'Thinking' }],
        status: 'streaming',
        seq: '001'
      }
    ],
    liveTools: [
      {
        kind: 'tool',
        id: 'exa_steve0000000',
        tool: 'external-agent:codex',
        input: { agent: 'pmem_steve', provider: 'codex', productIcon: 'codex' },
        status: 'running',
        seq: '002'
      }
    ],
    externalAgentDisplayNames: new Map([['pmem_steve', 'Steve']])
  });

  expect(messages).toEqual([]);
});

test('managed message author snapshot wins over current project member metadata', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    externalAgentSessions: [],
    liveItems: [
      {
        kind: 'message',
        id: 'msg_fablehistory',
        role: 'assistant',
        agentName: 'pmem_claude_fable',
        agentDisplayName: 'Fable',
        source: 'managed-external-agent',
        parts: [{ type: 'text', text: 'Historical response' }],
        status: 'done',
        seq: '001'
      }
    ],
    liveTools: [],
    externalAgentDisplayNames: new Map([['pmem_claude_fable', 'Opus']])
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

test('managed external agent join stays before its first room message when live tool seq uses event ids', () => {
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
        type: 'external-agent',
        name: 'codex',
        instanceId: 'pmem_codex_a',
        displayName: 'A',
        joinedAt: '2026-07-02T10:00:01.000Z'
      }
    ],
    externalAgentSessions: [],
    liveItems: [],
    liveTools: [
      {
        kind: 'tool',
        id: 'exa_a00000000000',
        tool: 'external-agent:codex',
        input: { agent: 'pmem_codex_a', provider: 'codex', productIcon: 'codex' },
        status: 'running',
        seq: 'evt_01KWHJOIN000'
      }
    ],
    externalAgentDisplayNames: new Map([['pmem_codex_a', 'A']])
  });

  expect(messages.map((message) => [message.id, message.text])).toEqual([
    ['project-member-joined:pmem_codex_a', 'joined the project'],
    ['msg_agentgreqina', 'A joined and is ready to take project work.']
  ]);
});

test('managed external agent restart does not move replies from an earlier runtime', () => {
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
        externalAgentSessionId: 'exa_oldruntime000',
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
    externalAgentSessions: [
      externalAgentSession({
        id: 'exa_newruntime000',
        agentRuntimeId: 'exa_newruntime000',
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

test('external agent streams prefer live activity output over persisted snapshot', () => {
  const stream = firstExternalAgentStream(
    __workplaceProjectMessageTest.buildExternalAgentStreams(
      [externalAgentSession({ outputSnapshot: 'old snapshot' })],
      [
        {
          id: 'exa_01KWGEMIprD4',
          av: 'GE',
          tool: 'external-agent:gemini',
          detail: 'native cli activity',
          output: 'live output',
          status: 'running'
        }
      ]
    )
  );

  expect(stream).toMatchObject({
    id: 'exa_01KWGEMIprD4',
    agentName: 'gemini',
    provider: 'gemini',
    tag: 'Gemini',
    output: 'live output',
    items: [{ id: 'exa_01KWGEMIprD4:0', kind: 'assistant-message', text: 'live output' }],
    status: 'running'
  });
});

test('external agent streams carry their own transcript target for observation/history requests', () => {
  const stream = firstExternalAgentStream(
    __workplaceProjectMessageTest.buildExternalAgentStreams(
      [externalAgentSession({ sessionId: 'ses_01KWOWNER9zQ2' })],
      []
    )
  );

  expect(stream.transcriptTargetId).toBe('ses_01KWOWNER9zQ2');
});

test('external agent durable running sessions remain observable without marking generation active', () => {
  const stream = firstExternalAgentStream(
    __workplaceProjectMessageTest.buildExternalAgentStreams(
      [externalAgentSession({ outputSnapshot: 'previous turn output', state: 'running' })],
      []
    )
  );

  expect(stream).toMatchObject({
    id: 'exa_01KWGEMIprD4',
    agentName: 'gemini',
    output: 'previous turn output',
    status: 'ok',
    items: [{ id: 'exa_01KWGEMIprD4:0', kind: 'assistant-message', text: 'previous turn output' }]
  });
});

test('external agent live activity streams keep the managed agent identity', () => {
  const stream = firstExternalAgentStream(
    __workplaceProjectMessageTest.buildExternalAgentStreams(
      [],
      [
        {
          id: 'exa_livecodex000',
          av: 'CO',
          agentName: 'codex',
          tool: 'external-agent:codex',
          detail: 'external-agent:codex',
          output: 'thinking about the project message',
          status: 'running'
        }
      ]
    )
  );

  expect(stream).toMatchObject({
    id: 'exa_livecodex000',
    agentName: 'codex',
    status: 'running',
    items: [{ id: 'exa_livecodex000:0', kind: 'assistant-message', text: 'thinking about the project message' }]
  });
});

test('managed external agent streams retain template agent names for host usage queries', () => {
  const stream = firstExternalAgentStream(
    __workplaceProjectMessageTest.buildExternalAgentStreams(
      [
        externalAgentSession({
          id: 'exa_codexrev9zCF',
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
    id: 'exa_codexrev9zCF',
    agentName: 'pmem_codex_reviewer',
    templateAgentName: 'codex'
  });
});

test('external agent structured result output is projected as readable observation items', () => {
  const stream = firstExternalAgentStream(
    __workplaceProjectMessageTest.buildExternalAgentStreams(
      [],
      [
        {
          id: 'exa_structuryOpn',
          av: 'CO',
          agentName: 'codex',
          tool: 'external-agent:codex',
          detail: 'external-agent:codex',
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
    { id: 'exa_structuryOpn:result', text: '仍被拦截，无法发出。卡点未变：`monad project` 命令需要你批准。' },
    { id: 'exa_structuryOpn:denial:0', text: 'Permission blocked Bash: monad project post "你好！"' }
  ]);
});

test('external agent stream-json events are projected as readable observation items', () => {
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

  const stream = firstExternalAgentStream(
    __workplaceProjectMessageTest.buildExternalAgentStreams(
      [],
      [
        {
          id: 'exa_streamevents',
          av: 'CO',
          agentName: 'claude-code',
          tool: 'external-agent:claude-code',
          detail: 'external-agent:claude-code',
          output,
          status: 'running'
        }
      ]
    )
  );

  expect(observationFields(stream.items)).toEqual([
    { id: 'exa_streamevents:json:0:message:0', text: 'I can help.' },
    { id: 'exa_streamevents:json:0:tool:1', text: 'Tool call Bash' },
    { id: 'exa_streamevents:json:1:delta', text: 'Streaming text.' },
    { id: 'exa_streamevents:json:2:tool-result', text: 'command output' },
    { id: 'exa_streamevents:json:3:result', text: 'Done.' }
  ]);
});

test('external agent projection ignores startup prose before stream-json objects', () => {
  const output = [
    'started claude-code in /Users/test/.monad/workplace-agents/project/claude-code',
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session' }),
    JSON.stringify({ type: 'result', result: 'Need approval before posting.' })
  ].join('\n');

  const stream = firstExternalAgentStream(
    __workplaceProjectMessageTest.buildExternalAgentStreams(
      [],
      [
        {
          id: 'exa_mixedclaude0',
          av: 'CL',
          agentName: 'claude-code',
          tool: 'external-agent:claude-code',
          detail: 'external-agent:claude-code',
          output,
          status: 'running'
        }
      ]
    )
  );

  // The `system` init notice now surfaces as a `system` kind (session lifecycle notices, e.g. login,
  // must stay visible in backfilled history); the result survives as a turn-end with its final text.
  expect(observationFields(stream.items)).toEqual([
    { id: 'exa_mixedclaude0:json:0:system', text: 'init' },
    { id: 'exa_mixedclaude0:json:1:result', text: 'Need approval before posting.' }
  ]);
});

test('external agent app-server JSON-RPC output is projected as readable observation items', () => {
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

  const stream = firstExternalAgentStream(
    __workplaceProjectMessageTest.buildExternalAgentStreams(
      [],
      [
        {
          id: 'exa_appserveQWB9',
          av: 'CO',
          agentName: 'test',
          tool: 'external-agent:codex',
          detail: 'external-agent:codex',
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
      id: 'exa_appserveQWB9:json:0:thread-started',
      text: 'Thread started in /Users/test/project/.dev/.monad/workplace-agents/project/test'
    },
    { id: 'exa_appserveQWB9:json:1:mcp-status', text: 'node_repl starting' }
  ]);
});

test('external agent follow streams restore persisted terminal snapshots', () => {
  const stream = firstExternalAgentStream(
    __workplaceProjectMessageTest.buildExternalAgentStreams(
      [externalAgentSession({ outputSnapshot: '\\x1b[38;2;255;193;7mraw terminal output' })],
      []
    )
  );

  expect(stream).toMatchObject({
    id: 'exa_01KWGEMIprD4',
    output: '\\x1b[38;2;255;193;7mraw terminal output',
    items: [
      {
        id: 'exa_01KWGEMIprD4:0',
        kind: 'assistant-message',
        text: '\\x1b[38;2;255;193;7mraw terminal output'
      }
    ]
  });
});

test('typed idle suspension uses the configured project member identity', () => {
  const avatarUrl = __workplaceProjectMessageTest.entityAvatarUrl('external-agent-instance:reviewer');
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    projectMembers: [
      {
        id: 'pmem_codex_reviewer',
        type: 'external-agent',
        name: 'codex',
        displayName: 'Reviewer'
      }
    ],
    externalAgentSessions: [],
    liveItems: [
      {
        kind: 'system',
        id: 'external-agent-idle-suspended:pmem_codex_reviewer',
        text: 'fell asleep.',
        event: {
          agentId: 'pmem_codex_reviewer',
          agentName: 'Reviewer',
          type: 'idle_suspended',
          payload: { externalAgentSessionId: 'exa_codexreviewer', idleTimeoutMs: 300_000 }
        },
        seq: 'evt_idle_suspended'
      }
    ],
    liveTools: [],
    externalAgentDisplayNames: new Map([['pmem_codex_reviewer', 'Review Lead']]),
    externalAgentAvatarSeeds: new Map([['Review Lead', 'external-agent-instance:reviewer']]),
    externalAgentIcons: new Map([['pmem_codex_reviewer', 'codex']]),
    externalAgentTags: new Map([['pmem_codex_reviewer', 'Codex']])
  });

  expect(messages).toEqual([
    {
      id: 'external-agent-idle-suspended:pmem_codex_reviewer',
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
  const avatarUrl = __workplaceProjectMessageTest.entityAvatarUrl('external-agent-instance:reviewer');
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    projectMembers: [
      {
        id: 'pmem_codex_reviewer',
        type: 'external-agent',
        name: 'codex',
        displayName: 'Reviewer'
      }
    ],
    externalAgentSessions: [],
    liveItems: [
      {
        kind: 'system',
        id: 'external-agent-idle-resumed:pmem_codex_reviewer',
        text: 'woke up.',
        event: {
          agentId: 'pmem_codex_reviewer',
          agentName: 'Reviewer',
          type: 'idle_resumed',
          payload: { externalAgentSessionId: 'exa_codexreviewer' }
        },
        seq: 'evt_idle_resumed'
      }
    ],
    liveTools: [],
    externalAgentDisplayNames: new Map([['pmem_codex_reviewer', 'Review Lead']]),
    externalAgentAvatarSeeds: new Map([['Review Lead', 'external-agent-instance:reviewer']]),
    externalAgentIcons: new Map([['pmem_codex_reviewer', 'codex']]),
    externalAgentTags: new Map([['pmem_codex_reviewer', 'Codex']])
  });

  expect(messages).toEqual([
    {
      id: 'external-agent-idle-resumed:pmem_codex_reviewer',
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
  const avatarUrl = __workplaceProjectMessageTest.entityAvatarUrl('external-agent:Monad');
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    externalAgentSessions: [],
    liveItems: [
      {
        kind: 'system',
        id: 'external-agent-idle-suspended:pmem_codex_unconfigured',
        text: 'fell asleep.',
        event: {
          agentId: 'pmem_codex_unconfigured',
          agentName: 'Monad',
          type: 'idle_suspended',
          payload: { externalAgentSessionId: 'exa_codexunknown', idleTimeoutMs: 300_000 }
        },
        seq: 'evt_idle_unconfigured'
      }
    ],
    liveTools: []
  });

  expect(messages).toEqual([
    {
      id: 'external-agent-idle-suspended:pmem_codex_unconfigured',
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

test('external agent resume failure without a typed event keeps the legacy ID fallback', () => {
  const avatarUrl = __workplaceProjectMessageTest.entityAvatarUrl('external-agent-resume:codex');
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    externalAgentSessions: [],
    liveItems: [
      {
        kind: 'system',
        id: 'external-agent-resume-failed:codex',
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
      id: 'external-agent-resume-failed:codex',
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

test('external agent project member presence treats spawned runtime as online until it generates', () => {
  expect(
    __workplaceProjectMessageTest.externalAgentMemberPresence({
      agentName: 'gemini',
      enabled: true,
      externalAgentSessions: [],
      liveTools: []
    })
  ).toBe('online');

  expect(
    __workplaceProjectMessageTest.externalAgentMemberPresence({
      agentName: 'gemini',
      enabled: true,
      externalAgentSessions: [],
      liveTools: [
        {
          id: 'tool_observation',
          kind: 'tool',
          tool: 'external-agent:gemini',
          input: { agent: 'gemini' },
          output: 'provider runtime output',
          status: 'running',
          seq: '002'
        } as never
      ]
    })
  ).toBe('online');

  expect(
    __workplaceProjectMessageTest.externalAgentMemberPresence({
      agentName: 'gemini',
      enabled: true,
      externalAgentSessions: [],
      liveTools: [
        {
          id: 'tool_login',
          kind: 'tool',
          tool: 'external-agent:gemini',
          input: { agent: 'gemini' },
          output: 'connection_required: sign in',
          status: 'running',
          seq: '003'
        } as never
      ]
    })
  ).toBe('needs-login');

  expect(
    __workplaceProjectMessageTest.externalAgentMemberPresence({
      agentName: 'gemini',
      enabled: true,
      externalAgentSessions: [externalAgentSession({ state: 'failed', outputSnapshot: 'process exited 1' })],
      liveTools: []
    })
  ).toBe('failed');

  expect(
    __workplaceProjectMessageTest.externalAgentMemberPresence({
      agentName: 'gemini',
      enabled: true,
      externalAgentSessions: [externalAgentSession({ state: 'stopped' })],
      liveTools: []
    })
  ).toBe('online');
});

test('external agent presence ignores login phrases inside Claude tool results', () => {
  const session = externalAgentSession({
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
    __workplaceProjectMessageTest.externalAgentMemberPresence({
      agentName: 'pmem_claude',
      enabled: true,
      externalAgentSessions: [session],
      liveTools: []
    })
  ).toBe('online');
});

test('external agent presence keeps structured authentication failures', () => {
  const session = externalAgentSession({
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
    __workplaceProjectMessageTest.externalAgentMemberPresence({
      agentName: 'pmem_claude',
      enabled: true,
      externalAgentSessions: [session],
      liveTools: []
    })
  ).toBe('needs-login');
});

test('external agent project member presence treats lifecycle tools as stand-by availability', () => {
  expect(
    __workplaceProjectMessageTest.externalAgentMemberPresence({
      agentName: 'gemini',
      enabled: true,
      externalAgentSessions: [],
      liveTools: [
        {
          id: 'exa_session00000',
          kind: 'tool',
          tool: 'external-agent:gemini',
          input: { agent: 'gemini' },
          status: 'running',
          seq: '002'
        } as never
      ]
    })
  ).toBe('online');
});

test('external agent project member presence treats streaming managed messages as active generation', () => {
  expect(
    __workplaceProjectMessageTest.externalAgentMemberPresence({
      agentName: 'gemini',
      enabled: true,
      externalAgentSessions: [],
      liveTools: [],
      activeAgentNames: new Set(['gemini'])
    })
  ).toBe('working');
});

test('external agent project member presence shows running sessions with provider approvals as working', () => {
  expect(
    __workplaceProjectMessageTest.externalAgentMemberPresence({
      agentName: 'gemini',
      enabled: true,
      externalAgentSessions: [
        externalAgentSession({
          pendingApprovalCount: 1
        } as Partial<ExternalAgentSessionView> & { pendingApprovalCount: number })
      ],
      liveTools: []
    })
  ).toBe('working');
});

test('external agent project member presence is scoped by managed member instance id', () => {
  expect(
    __workplaceProjectMessageTest.externalAgentMemberPresence({
      agentName: 'pmem_codex_reviewer',
      enabled: true,
      externalAgentSessions: [],
      liveTools: [
        {
          id: 'tool_other_codex',
          kind: 'tool',
          tool: 'external-agent:codex',
          input: { agent: 'pmem_codex_writer' },
          status: 'running',
          seq: '002'
        } as never
      ]
    })
  ).toBe('online');

  expect(
    __workplaceProjectMessageTest.externalAgentMemberPresence({
      agentName: 'pmem_codex_reviewer',
      enabled: true,
      externalAgentSessions: [],
      liveTools: [],
      activeAgentNames: new Set(['pmem_codex_reviewer'])
    })
  ).toBe('working');
});

test('external agent project members default to managed project runtime', () => {
  expect(
    __workplaceProjectMessageTest.defaultProjectMemberSettings('external-agent', {
      defaultLaunchMode: 'pty'
    })
  ).toEqual({
    launchMode: 'pty',
    managedProjectAgent: true
  });
});

test('external agent project members derive template and instance identity from the template itself', () => {
  const [member] = __workplaceProjectMessageTest.parseProjectMembers([
    {
      id: 'pmem_codex_reviewer',
      type: 'external-agent',
      name: 'codex',
      displayName: 'codex-reviewer',
      settings: {
        managedProjectAgent: true,
        launchMode: 'app-server',
        modelId: 'gpt-5.5',
        reasoningEffort: 'high',
        speed: 'fast',
        customPrompt: 'Review only correctness issues.'
      }
    }
  ]);

  expect(member).toMatchObject({
    id: 'pmem_codex_reviewer',
    type: 'external-agent',
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

test('external agent product display names use official client names', () => {
  expect(__workplaceProjectMessageTest.externalAgentProductDisplayName('codex', 'codex', 'codex')).toBe('OpenAI Codex');
  expect(
    __workplaceProjectMessageTest.externalAgentProductDisplayName('claude-code', 'claude-code', 'claude-code')
  ).toBe('Claude Code');
  expect(__workplaceProjectMessageTest.externalAgentProductDisplayName('gemini', 'gemini', 'gemini')).toBe(
    'Gemini CLI'
  );
  expect(__workplaceProjectMessageTest.externalAgentProductDisplayName('qwen', 'qwen', 'qwen')).toBe('Qwen Code');
});

test('external agent project member rename preserves runtime identity fields', () => {
  const member = __workplaceProjectMessageTest.renameExternalAgentProjectMemberDisplayName(
    {
      id: 'pmem_codex_reviewer',
      type: 'external-agent',
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
    type: 'external-agent',
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
        type: 'external-agent',
        name: 'codex-reviewer',
        joinedAt: '2026-06-29T10:00:00.000Z'
      },
      'codex-reviewer'
    )
  ).toMatchObject({
    avatarUrl: __workplaceProjectMessageTest.entityAvatarUrl('external-agent:codex-reviewer'),
    agentChip: {
      avatarUrl: __workplaceProjectMessageTest.entityAvatarUrl('external-agent:codex-reviewer')
    }
  });
});

test('external agent system and assistant messages share the same instance avatar url', () => {
  const avatarUrl = __workplaceProjectMessageTest.entityAvatarUrl('external-agent-instance:reviewer');
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    projectMembers: [
      {
        id: 'pmem_codex_reviewer',
        type: 'external-agent',
        name: 'codex',
        instanceId: 'pmem_codex_reviewer',
        displayName: 'Reviewer',
        joinedAt: '2026-06-29T10:00:00.000Z'
      }
    ],
    externalAgentSessions: [
      externalAgentSession({ agentName: 'pmem_codex_reviewer', productIcon: 'codex', provider: 'codex' })
    ],
    liveItems: [
      {
        id: 'msg_reply0000000',
        kind: 'message',
        role: 'assistant',
        agentName: 'pmem_codex_reviewer',
        source: 'managed-external-agent',
        parts: [{ type: 'text', text: 'Done' }],
        status: 'complete',
        seq: '002'
      }
    ] as never,
    liveTools: [],
    externalAgentDisplayNames: new Map([['pmem_codex_reviewer', 'Reviewer']]),
    externalAgentAvatarSeeds: new Map([['Reviewer', 'external-agent-instance:reviewer']])
  });

  const joined = messages.find((message) => message.id.startsWith('project-member-joined:'));
  const reply = messages.find((message) => message.id === 'msg_reply0000000');

  expect(joined?.avatarUrl).toBe(avatarUrl);
  expect(joined?.agentChip?.avatarUrl).toBe(avatarUrl);
  expect(reply?.avatarUrl).toBe(avatarUrl);
});

test('external agent assistant messages keep provider icon when display name is custom', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    externalAgentSessions: [
      externalAgentSession({ agentName: 'pmem_codex_reviewer', productIcon: 'codex', provider: 'codex' })
    ],
    liveItems: [
      {
        id: 'msg_reply0000000',
        kind: 'message',
        role: 'assistant',
        agentName: 'pmem_codex_reviewer',
        source: 'managed-external-agent',
        parts: [{ type: 'text', text: 'Done' }],
        status: 'complete',
        seq: '002'
      }
    ] as never,
    liveTools: [],
    externalAgentDisplayNames: new Map([['pmem_codex_reviewer', 'Lily']]),
    externalAgentIcons: new Map([['pmem_codex_reviewer', 'codex']]),
    externalAgentTags: new Map([['pmem_codex_reviewer', 'Codex']])
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
