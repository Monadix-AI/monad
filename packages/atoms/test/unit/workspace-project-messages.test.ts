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
  id: 'exa_01KWGEMINI000000000000000',
  transcriptTargetId: 'prj_01KWPROJECT00000000000000',
  agentName: 'gemini',
  provider: 'gemini',
  productIcon: 'gemini',
  workingPath: '/Users/zeke/Projects/monad',
  launchMode: 'pty',
  approvalOwnership: 'provider-owned',
  runtimeRole: 'managed-project-agent',
  agentRuntimeId: 'exa_01KWGEMINI000000000000000',
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
) =>
  items.map(({ id, providerEventType, role, source, text }) => ({
    id,
    role,
    text,
    source,
    providerEventType
  }));

function firstExternalAgentStream(streams: ReturnType<typeof __workplaceProjectMessageTest.buildExternalAgentStreams>) {
  const stream = streams[0];
  if (!stream) throw new Error('expected an external agent stream');
  return stream;
}

test('external agent sessions project to durable chat messages', () => {
  const message = __workplaceProjectMessageTest.externalAgentSessionMessage(externalAgentSession());

  expect(message).toMatchObject({
    id: 'external-agent-session:exa_01KWGEMINI000000000000000',
    authorName: 'gemini',
    icon: 'gemini',
    kind: 'system',
    tag: 'Gemini',
    text: 'joined the project',
    agentChip: {
      id: 'gemini',
      name: 'gemini',
      icon: 'gemini',
      tag: 'Gemini'
    },
    externalAgentSessionId: 'exa_01KWGEMINI000000000000000',
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
  expect(__workplaceProjectMessageTest.parseProjectMembers([{ type: 'monad', name: 'monad' }])).toEqual([
    { id: 'monad', type: 'monad', name: 'monad' }
  ]);
});

test('external agent developer messages expose only a follow entry', () => {
  const message = __workplaceProjectMessageTest.externalAgentSessionDeveloperMessage(externalAgentSession());

  expect(message).toMatchObject({
    id: 'external-agent-session-developer:exa_01KWGEMINI000000000000000',
    kind: 'developer',
    tag: 'DEV',
    text: 'CLI stream available',
    externalAgentSessionId: 'exa_01KWGEMINI000000000000000',
    developerOnly: true,
    orderKey: '2026-06-29T10:00:00.000Z:developer'
  });
});

test('external agent durable sessions keep timeline populated after live tool settles', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    externalAgentSessions: [externalAgentSession()],
    liveItems: [],
    liveTools: []
  });

  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    id: 'external-agent-session:exa_01KWGEMINI000000000000000',
    authorName: 'gemini',
    kind: 'system',
    text: 'joined the project',
    agentChip: { id: 'gemini', name: 'gemini' }
  });
});

test('Claude server errors project as agent-scoped system messages', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    externalAgentSessions: [
      externalAgentSession({
        id: 'exa_claude_error',
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
    ['external-agent-session:exa_claude_error', 'joined the project'],
    ['external-agent-session-error:exa_claude_error:exa_claude_error:result', 'encountered an error']
  ]);
  expect(messages[1]).toMatchObject({
    authorId: 'pmem_claude_1234',
    authorName: 'Steve',
    kind: 'system',
    tag: 'Claude',
    externalAgentSessionId: 'exa_claude_error',
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
  const _hidden = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    externalAgentSessions: [],
    liveItems: [],
    liveTools: [
      {
        id: 'exa_live',
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
        id: 'exa_live',
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

  expect(visible.find((message) => message.kind === 'developer')).toMatchObject({
    id: 'external-agent-session-developer:exa_live',
    text: 'CLI stream available'
  });
});

test('external agent runtime lifecycle projects the current join per project member', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    externalAgentSessions: [
      externalAgentSession({
        id: 'exa_first',
        agentName: 'codex',
        provider: 'codex',
        productIcon: 'codex',
        state: 'stopped',
        startedAt: '2026-06-29T10:00:00.000Z',
        updatedAt: '2026-06-29T10:01:00.000Z',
        exitedAt: '2026-06-29T10:01:00.000Z'
      }),
      externalAgentSession({
        id: 'exa_second',
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

  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    id: 'external-agent-session:exa_second',
    authorName: 'codex',
    text: 'joined the project'
  });
});

test('managed external agent timeline messages use display names instead of runtime ids', () => {
  const displayNames = new Map([['pmem_codex_abcd1234', 'codex-reviewer']]);
  const avatarSeeds = new Map([['codex-reviewer', 'external-agent:codex-reviewer']]);
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    externalAgentSessions: [
      externalAgentSession({
        id: 'exa_display',
        agentName: 'pmem_codex_abcd1234',
        provider: 'codex',
        productIcon: 'codex'
      })
    ],
    liveItems: [
      {
        kind: 'message',
        id: 'msg_cli_reply',
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

  expect(messages.map((message) => message.authorName)).toEqual(['codex-reviewer', 'codex-reviewer']);
  expect(messages.map((message) => message.authorId)).toEqual(['pmem_codex_abcd1234', 'pmem_codex_abcd1234']);
  expect(messages[0]?.agentChip).toMatchObject({ id: 'pmem_codex_abcd1234', name: 'codex-reviewer' });
});

test('managed external agent reasoning-only streaming messages stay off the transcript wall', () => {
  const _messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    externalAgentSessions: [],
    liveItems: [
      {
        kind: 'message',
        id: 'msg_codex_thinking',
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
});

test('managed external agent terminal reasoning-only messages stay off the transcript wall', () => {
  const _messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    externalAgentSessions: [],
    liveItems: [
      {
        kind: 'message',
        id: 'msg_codex_orphaned_thinking',
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
});

test('external agent live start projects joined without raw terminal output', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    externalAgentSessions: [],
    liveItems: [],
    liveTools: [
      {
        id: 'exa_live',
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

  const joined = messages.find((message) => message.id === 'external-agent-session:exa_live');
  const developer = messages.find((message) => message.kind === 'developer');
  expect(joined).toMatchObject({
    kind: 'system',
    authorName: 'claude-code',
    text: 'joined the project',
    externalAgentSessionId: 'exa_live'
  });
  expect(developer).toMatchObject({
    id: 'external-agent-session-developer:exa_live',
    text: 'CLI stream available',
    externalAgentSessionId: 'exa_live'
  });
});

test('external agent live starts project only one member join per agent', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    externalAgentSessions: [],
    liveItems: [],
    liveTools: [
      {
        id: 'exa_first',
        kind: 'tool',
        tool: 'external-agent:codex',
        input: { agent: 'pmem_codex_a', provider: 'codex', productIcon: 'codex' },
        status: 'running',
        seq: '001'
      } as never,
      {
        id: 'exa_second',
        kind: 'tool',
        tool: 'external-agent:codex',
        input: { agent: 'pmem_codex_a', provider: 'codex', productIcon: 'codex' },
        status: 'running',
        seq: '002'
      } as never
    ],
    externalAgentDisplayNames: new Map([['pmem_codex_a', 'A']])
  });

  expect(messages.filter((message) => message.text === 'joined the project')).toHaveLength(1);
  expect(messages.find((message) => message.text === 'joined the project')).toMatchObject({
    id: 'external-agent-session:exa_first',
    authorId: 'pmem_codex_a',
    authorName: 'A',
    externalAgentSessionId: 'exa_first'
  });
});

test('managed external agent reasoning-only fanout does not project a system divider', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [
      {
        id: 'msg_user',
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
        id: 'msg_codex_thinking',
        role: 'assistant',
        agentName: 'codex',
        source: 'managed-external-agent',
        parts: [{ type: 'reasoning', text: 'Thinking' }],
        status: 'streaming',
        seq: '002'
      },
      {
        kind: 'message',
        id: 'msg_claude_thinking',
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
  expect(messages.map((message) => message.id)).toEqual(['msg_user']);
});

test('managed external agent finished replies render without a thinking placeholder', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [
      {
        id: 'msg_user',
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
        id: 'msg_codex_reply',
        role: 'assistant',
        agentName: 'codex',
        source: 'managed-external-agent',
        parts: [{ type: 'text', text: 'Done.' }],
        status: 'done',
        seq: '002'
      },
      {
        kind: 'message',
        id: 'msg_claude_thinking',
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

  expect(messages.map((message) => message.id)).toEqual(['msg_user', 'msg_codex_reply']);
});

test('managed external agent finished replies retain delivery observation pointers', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    externalAgentSessions: [],
    liveItems: [
      {
        kind: 'message',
        id: 'msg_codex_reply',
        role: 'assistant',
        agentName: 'pmem_codex_abcd1234',
        source: 'managed-external-agent',
        externalAgentSessionId: 'exa_codex_delivery',
        deliveryId: 'deliv_01KWEBDELIVERYOBSERVE000',
        parts: [{ type: 'text', text: 'Done.' }],
        status: 'done',
        seq: '2026-06-29T10:00:01.000Z'
      }
    ],
    liveTools: [],
    externalAgentDisplayNames: new Map([['pmem_codex_abcd1234', 'codex-reviewer']])
  });

  expect(messages[0]).toMatchObject({
    id: 'msg_codex_reply',
    externalAgentSessionId: 'exa_codex_delivery',
    deliveryId: 'deliv_01KWEBDELIVERYOBSERVE000'
  });
});

test('managed external agent spawn projects joined without a thinking placeholder', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    externalAgentSessions: [],
    liveItems: [
      {
        kind: 'message',
        id: 'msg_steve_thinking',
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
        id: 'exa_steve',
        tool: 'external-agent:codex',
        input: { agent: 'pmem_steve', provider: 'codex', productIcon: 'codex' },
        status: 'running',
        seq: '002'
      }
    ],
    externalAgentDisplayNames: new Map([['pmem_steve', 'Steve']])
  });

  expect(messages.map((message) => [message.id, message.text])).toEqual([
    ['external-agent-session:exa_steve', 'joined the project']
  ]);
});

test('managed external agent join stays before its first room message when live tool seq uses event ids', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [
      {
        id: 'msg_agent_greeting',
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
    externalAgentSessions: [],
    liveItems: [],
    liveTools: [
      {
        kind: 'tool',
        id: 'exa_a',
        tool: 'external-agent:codex',
        input: { agent: 'pmem_codex_a', provider: 'codex', productIcon: 'codex' },
        status: 'running',
        seq: 'evt_01KWHJOIN'
      }
    ],
    externalAgentDisplayNames: new Map([['pmem_codex_a', 'A']])
  });

  expect(messages.map((message) => [message.id, message.text])).toEqual([
    ['external-agent-session:exa_a', 'joined the project'],
    ['msg_agent_greeting', 'A joined and is ready to take project work.']
  ]);
});

test('external agent streams prefer live activity output over persisted snapshot', () => {
  const stream = firstExternalAgentStream(
    __workplaceProjectMessageTest.buildExternalAgentStreams(
      [externalAgentSession({ outputSnapshot: 'old snapshot' })],
      [
        {
          id: 'exa_01KWGEMINI000000000000000',
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
    id: 'exa_01KWGEMINI000000000000000',
    agentName: 'gemini',
    provider: 'gemini',
    tag: 'Gemini',
    output: 'live output',
    items: [{ id: 'exa_01KWGEMINI000000000000000:0', role: 'agent', text: 'live output' }],
    status: 'running'
  });
});

test('external agent durable running sessions remain observable without marking generation active', () => {
  const stream = firstExternalAgentStream(
    __workplaceProjectMessageTest.buildExternalAgentStreams(
      [externalAgentSession({ outputSnapshot: 'previous turn output', state: 'running' })],
      []
    )
  );

  expect(stream).toMatchObject({
    id: 'exa_01KWGEMINI000000000000000',
    agentName: 'gemini',
    output: 'previous turn output',
    status: 'ok',
    items: [{ id: 'exa_01KWGEMINI000000000000000:0', role: 'agent', text: 'previous turn output' }]
  });
});

test('external agent live activity streams keep the managed agent identity', () => {
  const stream = firstExternalAgentStream(
    __workplaceProjectMessageTest.buildExternalAgentStreams(
      [],
      [
        {
          id: 'exa_live_codex',
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
    id: 'exa_live_codex',
    agentName: 'codex',
    status: 'running',
    items: [{ id: 'exa_live_codex:0', role: 'agent', text: 'thinking about the project message' }]
  });
});

test('managed external agent streams retain template agent names for host usage queries', () => {
  const stream = firstExternalAgentStream(
    __workplaceProjectMessageTest.buildExternalAgentStreams(
      [
        externalAgentSession({
          id: 'exa_codex_reviewer',
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
    id: 'exa_codex_reviewer',
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
          id: 'exa_structured_codex',
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
    {
      id: 'exa_structured_codex:result',
      role: 'agent',
      text: '仍被拦截，无法发出。卡点未变：`monad project` 命令需要你批准。',
      source: 'codex-exec',
      providerEventType: 'result'
    },
    {
      id: 'exa_structured_codex:denial:0',
      role: 'tool',
      text: 'Permission blocked Bash: monad project post "你好！"',
      source: 'codex-exec',
      providerEventType: 'permission_denial'
    }
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
          id: 'exa_stream_events',
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
    {
      id: 'exa_stream_events:json:0:message:0',
      role: 'agent',
      text: 'I can help.',
      source: 'claude-code-sdk',
      providerEventType: 'assistant'
    },
    {
      id: 'exa_stream_events:json:0:tool:1',
      role: 'tool',
      text: 'Tool call Bash',
      source: 'claude-code-sdk',
      providerEventType: 'assistant'
    },
    {
      id: 'exa_stream_events:json:1:delta',
      role: 'agent',
      text: 'Streaming text.',
      source: 'claude-code-sdk',
      providerEventType: 'content_block_delta'
    },
    {
      id: 'exa_stream_events:json:2:tool-result',
      role: 'tool',
      text: 'command output',
      source: 'claude-code-sdk',
      providerEventType: 'tool_result'
    },
    {
      id: 'exa_stream_events:json:3:result',
      role: 'agent',
      text: 'Done.',
      source: 'claude-code-sdk',
      providerEventType: 'result'
    }
  ]);
});

test('external agent projection ignores startup prose before stream-json objects', () => {
  const output = [
    'started claude-code in /Users/zeke/.monad/workplace-agents/project/claude-code',
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session' }),
    JSON.stringify({ type: 'result', result: 'Need approval before posting.' })
  ].join('\n');

  const stream = firstExternalAgentStream(
    __workplaceProjectMessageTest.buildExternalAgentStreams(
      [],
      [
        {
          id: 'exa_mixed_claude',
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

  expect(observationFields(stream.items)).toEqual([
    {
      id: 'exa_mixed_claude:json:0:system',
      role: 'system',
      text: 'init',
      source: 'claude-code-sdk',
      providerEventType: 'system'
    },
    {
      id: 'exa_mixed_claude:json:1:result',
      role: 'agent',
      text: 'Need approval before posting.',
      source: 'claude-code-sdk',
      providerEventType: 'result'
    }
  ]);
});

test('external agent app-server JSON-RPC output is projected as readable observation items', () => {
  const output = [
    JSON.stringify({
      method: 'thread/started',
      params: {
        thread: {
          id: '019f1f3a-5e8d-7260-a35e-c755a13bfde2',
          cwd: '/Users/zeke/.codex/worktrees/28ea/monad/.dev/.monad/workplace-agents/project/test'
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
          id: 'exa_app_server_codex',
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

  expect(observationFields(stream.items)).toEqual([
    {
      id: 'exa_app_server_codex:json:0:thread-started',
      role: 'system',
      text: 'Thread started in /Users/zeke/.codex/worktrees/28ea/monad/.dev/.monad/workplace-agents/project/test',
      source: 'codex-app-server',
      providerEventType: 'thread/started'
    },
    {
      id: 'exa_app_server_codex:json:1:mcp-status',
      role: 'tool',
      text: 'node_repl starting',
      source: 'codex-app-server',
      providerEventType: 'mcpServer/startupStatus/updated'
    }
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
    id: 'exa_01KWGEMINI000000000000000',
    output: '\\x1b[38;2;255;193;7mraw terminal output',
    items: [
      {
        id: 'exa_01KWGEMINI000000000000000:0',
        role: 'agent',
        source: 'plain-text',
        text: '\\x1b[38;2;255;193;7mraw terminal output'
      }
    ]
  });
});

test('external agent resume failure is visible as a project system message', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    externalAgentSessions: [],
    liveItems: [
      {
        kind: 'system',
        id: 'external-agent-resume-failed:codex',
        text: 'Codex resume failed for provider session codex-thread-stale; cold started a new runtime.',
        level: 'warn',
        seq: 'evt_resume_failed'
      }
    ],
    liveTools: [],
    showDeveloperOnlyMessages: false
  });

  expect(messages).toEqual([
    expect.objectContaining({
      id: 'external-agent-resume-failed:codex',
      authorName: 'codex',
      kind: 'system',
      tag: 'CLI',
      text: 'Codex resume failed for provider session codex-thread-stale; cold started a new runtime.',
      orderKey: 'evt_resume_failed'
    })
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

test('external agent project member presence treats lifecycle tools as stand-by availability', () => {
  expect(
    __workplaceProjectMessageTest.externalAgentMemberPresence({
      agentName: 'gemini',
      enabled: true,
      externalAgentSessions: [],
      liveTools: [
        {
          id: 'exa_session',
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

test('external agent project members preserve template and instance identity', () => {
  const [member] = __workplaceProjectMessageTest.parseProjectMembers([
    {
      type: 'external-agent',
      name: 'codex-reviewer',
      templateName: 'codex',
      displayName: 'codex-reviewer',
      instanceId: 'pmem_codex_reviewer',
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
    name: 'codex-reviewer',
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
    __workplaceProjectMessageTest.externalAgentSessionMessage(externalAgentSession({ agentName: 'codex-reviewer' }))
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
    externalAgentSessions: [
      externalAgentSession({ agentName: 'pmem_codex_reviewer', productIcon: 'codex', provider: 'codex' })
    ],
    liveItems: [
      {
        id: 'msg_reply',
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

  const joined = messages.find((message) => message.id.startsWith('external-agent-session:'));
  const reply = messages.find((message) => message.id === 'msg_reply');

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
        id: 'msg_reply',
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

  expect(messages.find((message) => message.id === 'msg_reply')).toMatchObject({
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
