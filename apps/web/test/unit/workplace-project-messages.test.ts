import type { NativeCliSessionView } from '@monad/protocol';
import type { Message } from '../../features/workplace/types.ts';

import { expect, test } from 'bun:test';

import { __workplaceProjectMessageTest, projectMemberParticipants } from '../../features/workplace/use-project.ts';

const nativeCliSession = (overrides: Partial<NativeCliSessionView> = {}): NativeCliSessionView => ({
  id: 'ncli_01KWGEMINI000000000000000',
  transcriptTargetId: 'prj_01KWPROJECT00000000000000',
  agentName: 'gemini',
  provider: 'gemini',
  productIcon: 'gemini',
  workingPath: '/Users/zeke/Projects/monad',
  launchMode: 'pty',
  approvalOwnership: 'provider-owned',
  runtimeRole: 'managed-project-agent',
  agentRuntimeId: 'ncli_01KWGEMINI000000000000000',
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
  items: NonNullable<ReturnType<typeof __workplaceProjectMessageTest.buildNativeCliStreams>[number]>['items']
) =>
  items.map(({ id, providerEventType, role, source, text }) => ({
    id,
    role,
    text,
    source,
    providerEventType
  }));

test('native CLI sessions project to durable chat messages', () => {
  const message = __workplaceProjectMessageTest.nativeCliSessionMessage(nativeCliSession());

  expect(message).toMatchObject({
    id: 'native-cli-session:ncli_01KWGEMINI000000000000000',
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
    nativeCliSessionId: 'ncli_01KWGEMINI000000000000000',
    streaming: false,
    orderKey: '2026-06-29T10:00:00.000Z'
  });
  expect(message.text).not.toContain('/Users/zeke/Projects/monad');
});

test('project rail only includes Monad when explicitly invited', () => {
  expect(
    projectMemberParticipants([
      {
        id: 'me',
        av: 'ME',
        name: 'Operator',
        kind: 'human',
        tag: 'User',
        presence: 'online'
      }
    ])
  ).toEqual([]);

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

test('native CLI developer messages expose only a follow entry', () => {
  const message = __workplaceProjectMessageTest.nativeCliSessionDeveloperMessage(nativeCliSession());

  expect(message).toMatchObject({
    id: 'native-cli-session-developer:ncli_01KWGEMINI000000000000000',
    kind: 'developer',
    tag: 'DEV',
    text: 'CLI stream available',
    nativeCliSessionId: 'ncli_01KWGEMINI000000000000000',
    developerOnly: true,
    orderKey: '2026-06-29T10:00:00.000Z:developer'
  });
  expect(message.text).not.toContain('/Users/zeke/Projects/monad');
});

test('native CLI durable sessions keep timeline populated after live tool settles', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    nativeCliSessions: [nativeCliSession()],
    liveItems: [],
    liveTools: []
  });

  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    id: 'native-cli-session:ncli_01KWGEMINI000000000000000',
    authorName: 'gemini',
    kind: 'system',
    text: 'joined the project',
    agentChip: { id: 'gemini', name: 'gemini' }
  });
  expect(messages.find((message) => message.kind === 'developer')).toBeUndefined();
});

test('native CLI developer messages are projected only when explicitly enabled', () => {
  const hidden = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    nativeCliSessions: [],
    liveItems: [],
    liveTools: [
      {
        id: 'ncli_live',
        kind: 'tool',
        tool: 'native-cli:codex',
        input: { agent: 'codex', provider: 'codex', productIcon: 'codex' },
        output: 'raw terminal output',
        status: 'running',
        seq: '002'
      } as never
    ]
  });
  const visible = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    nativeCliSessions: [],
    liveItems: [],
    liveTools: [
      {
        id: 'ncli_live',
        kind: 'tool',
        tool: 'native-cli:codex',
        input: { agent: 'codex', provider: 'codex', productIcon: 'codex' },
        output: 'raw terminal output',
        status: 'running',
        seq: '002'
      } as never
    ],
    showDeveloperOnlyMessages: true
  });

  expect(hidden.find((message) => message.kind === 'developer')).toBeUndefined();
  expect(visible.find((message) => message.kind === 'developer')).toMatchObject({
    id: 'native-cli-session-developer:ncli_live',
    text: 'CLI stream available'
  });
});

test('native CLI runtime lifecycle only projects the first join per project member', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    nativeCliSessions: [
      nativeCliSession({
        id: 'ncli_first',
        agentName: 'codex',
        provider: 'codex',
        productIcon: 'codex',
        state: 'stopped',
        startedAt: '2026-06-29T10:00:00.000Z',
        updatedAt: '2026-06-29T10:01:00.000Z',
        exitedAt: '2026-06-29T10:01:00.000Z'
      }),
      nativeCliSession({
        id: 'ncli_second',
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
    id: 'native-cli-session:ncli_first',
    authorName: 'codex',
    text: 'joined the project'
  });
  expect(messages[0]?.text).not.toContain('left');
});

test('managed native CLI timeline messages use display names instead of runtime ids', () => {
  const displayNames = new Map([['pmem_codex_abcd1234', 'codex-reviewer']]);
  const avatarSeeds = new Map([['codex-reviewer', 'native-cli:codex-reviewer']]);
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    nativeCliSessions: [
      nativeCliSession({
        id: 'ncli_display',
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
        source: 'managed-native-cli',
        parts: [{ type: 'text', text: 'Ready.' }],
        status: 'done',
        seq: '2026-06-29T10:00:01.000Z'
      }
    ],
    liveTools: [],
    nativeCliAvatarSeeds: avatarSeeds,
    nativeCliDisplayNames: displayNames,
    showDeveloperOnlyMessages: false
  });

  expect(messages.map((message) => message.authorName)).toEqual(['codex-reviewer', 'codex-reviewer']);
  expect(messages.map((message) => message.authorId)).toEqual(['pmem_codex_abcd1234', 'pmem_codex_abcd1234']);
  expect(messages[0]?.agentChip).toMatchObject({ id: 'pmem_codex_abcd1234', name: 'codex-reviewer' });
});

test('managed native CLI reasoning-only streaming messages stay off the transcript wall', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    nativeCliSessions: [],
    liveItems: [
      {
        kind: 'message',
        id: 'msg_codex_thinking',
        role: 'assistant',
        agentName: 'pmem_codex_abcd1234',
        source: 'managed-native-cli',
        parts: [{ type: 'reasoning', text: 'Thinking' }],
        status: 'streaming',
        seq: '002'
      }
    ],
    liveTools: [],
    nativeCliDisplayNames: new Map([['pmem_codex_abcd1234', 'codex-reviewer']])
  });

  expect(messages).toHaveLength(0);
});

test('managed native CLI terminal reasoning-only messages stay off the transcript wall', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    nativeCliSessions: [],
    liveItems: [
      {
        kind: 'message',
        id: 'msg_codex_orphaned_thinking',
        role: 'assistant',
        agentName: 'pmem_codex_abcd1234',
        source: 'managed-native-cli',
        parts: [{ type: 'reasoning', text: 'Thinking' }],
        status: 'error',
        seq: '002'
      }
    ],
    liveTools: [],
    nativeCliDisplayNames: new Map([['pmem_codex_abcd1234', 'codex-reviewer']])
  });

  expect(messages).toHaveLength(0);
});

test('native CLI live start projects joined without raw terminal output', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    nativeCliSessions: [],
    liveItems: [],
    liveTools: [
      {
        id: 'ncli_live',
        kind: 'tool',
        tool: 'native-cli:claude-code',
        input: { agent: 'claude-code', provider: 'claude-code', productIcon: 'claude-code' },
        output: 'started claude-code\n\\x1b[38;2;255;193;7mraw terminal output',
        status: 'running',
        seq: '002'
      } as never
    ],
    showDeveloperOnlyMessages: true
  });

  const joined = messages.find((message) => message.id === 'native-cli-session:ncli_live');
  const developer = messages.find((message) => message.kind === 'developer');
  expect(joined).toMatchObject({
    kind: 'system',
    authorName: 'claude-code',
    text: 'joined the project',
    nativeCliSessionId: 'ncli_live'
  });
  expect(joined?.text).not.toContain('raw terminal output');
  expect(developer).toMatchObject({
    id: 'native-cli-session-developer:ncli_live',
    text: 'CLI stream available',
    nativeCliSessionId: 'ncli_live'
  });
  expect(developer?.text).not.toContain('raw terminal output');
});

test('managed native CLI reasoning-only fanout does not project a system divider', () => {
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
    nativeCliSessions: [],
    liveItems: [
      {
        kind: 'message',
        id: 'msg_codex_thinking',
        role: 'assistant',
        agentName: 'codex',
        source: 'managed-native-cli',
        parts: [{ type: 'reasoning', text: 'Thinking' }],
        status: 'streaming',
        seq: '002'
      },
      {
        kind: 'message',
        id: 'msg_claude_thinking',
        role: 'assistant',
        agentName: 'claude-code',
        source: 'managed-native-cli',
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

test('managed native CLI finished replies render without a thinking placeholder', () => {
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
    nativeCliSessions: [],
    liveItems: [
      {
        kind: 'message',
        id: 'msg_codex_reply',
        role: 'assistant',
        agentName: 'codex',
        source: 'managed-native-cli',
        parts: [{ type: 'text', text: 'Done.' }],
        status: 'done',
        seq: '002'
      },
      {
        kind: 'message',
        id: 'msg_claude_thinking',
        role: 'assistant',
        agentName: 'claude-code',
        source: 'managed-native-cli',
        parts: [{ type: 'reasoning', text: 'Thinking' }],
        status: 'streaming',
        seq: '003'
      }
    ],
    liveTools: []
  });

  expect(messages.map((message) => message.id)).toEqual(['msg_user', 'msg_codex_reply']);
});

test('managed native CLI spawn projects joined without a thinking placeholder', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    nativeCliSessions: [],
    liveItems: [
      {
        kind: 'message',
        id: 'msg_steve_thinking',
        role: 'assistant',
        agentName: 'pmem_steve',
        source: 'managed-native-cli',
        parts: [{ type: 'reasoning', text: 'Thinking' }],
        status: 'streaming',
        seq: '001'
      }
    ],
    liveTools: [
      {
        kind: 'tool',
        id: 'ncli_steve',
        tool: 'native-cli:codex',
        input: { agent: 'pmem_steve', provider: 'codex', productIcon: 'codex' },
        status: 'running',
        seq: '002'
      }
    ],
    nativeCliDisplayNames: new Map([['pmem_steve', 'Steve']])
  });

  expect(messages.map((message) => [message.id, message.text])).toEqual([
    ['native-cli-session:ncli_steve', 'joined the project']
  ]);
});

test('managed native CLI join stays before its first room message when live tool seq uses event ids', () => {
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
    nativeCliSessions: [],
    liveItems: [],
    liveTools: [
      {
        kind: 'tool',
        id: 'ncli_a',
        tool: 'native-cli:codex',
        input: { agent: 'pmem_codex_a', provider: 'codex', productIcon: 'codex' },
        status: 'running',
        seq: 'evt_01KWHJOIN'
      }
    ],
    nativeCliDisplayNames: new Map([['pmem_codex_a', 'A']])
  });

  expect(messages.map((message) => [message.id, message.text])).toEqual([
    ['native-cli-session:ncli_a', 'joined the project'],
    ['msg_agent_greeting', 'A joined and is ready to take project work.']
  ]);
});

test('native CLI streams prefer live activity output over persisted snapshot', () => {
  const [stream] = __workplaceProjectMessageTest.buildNativeCliStreams(
    [nativeCliSession({ outputSnapshot: 'old snapshot' })],
    [
      {
        id: 'ncli_01KWGEMINI000000000000000',
        av: 'GE',
        tool: 'native-cli:gemini',
        detail: 'native cli activity',
        output: 'live output',
        status: 'running'
      }
    ]
  );

  expect(stream).toMatchObject({
    id: 'ncli_01KWGEMINI000000000000000',
    agentName: 'gemini',
    provider: 'gemini',
    tag: 'Gemini',
    output: 'live output',
    items: [{ id: 'ncli_01KWGEMINI000000000000000:0', role: 'agent', text: 'live output' }],
    status: 'running'
  });
});

test('native CLI durable running sessions remain observable without marking generation active', () => {
  const [stream] = __workplaceProjectMessageTest.buildNativeCliStreams(
    [nativeCliSession({ outputSnapshot: 'previous turn output', state: 'running' })],
    []
  );

  expect(stream).toMatchObject({
    id: 'ncli_01KWGEMINI000000000000000',
    agentName: 'gemini',
    output: 'previous turn output',
    status: 'ok',
    items: [{ id: 'ncli_01KWGEMINI000000000000000:0', role: 'agent', text: 'previous turn output' }]
  });
});

test('native CLI live activity streams keep the managed agent identity', () => {
  const [stream] = __workplaceProjectMessageTest.buildNativeCliStreams(
    [],
    [
      {
        id: 'ncli_live_codex',
        av: 'CO',
        agentName: 'codex',
        tool: 'native-cli:codex',
        detail: 'native-cli:codex',
        output: 'thinking about the project message',
        status: 'running'
      }
    ]
  );

  expect(stream).toMatchObject({
    id: 'ncli_live_codex',
    agentName: 'codex',
    status: 'running',
    items: [{ id: 'ncli_live_codex:0', role: 'agent', text: 'thinking about the project message' }]
  });
});

test('native CLI structured result output is projected as readable observation items', () => {
  const [stream] = __workplaceProjectMessageTest.buildNativeCliStreams(
    [],
    [
      {
        id: 'ncli_structured_codex',
        av: 'CO',
        agentName: 'codex',
        tool: 'native-cli:codex',
        detail: 'native-cli:codex',
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
  );

  expect(observationFields(stream.items)).toEqual([
    {
      id: 'ncli_structured_codex:result',
      role: 'agent',
      text: '仍被拦截，无法发出。卡点未变：`monad project` 命令需要你批准。',
      source: 'codex-exec',
      providerEventType: 'result'
    },
    {
      id: 'ncli_structured_codex:denial:0',
      role: 'tool',
      text: 'Permission blocked Bash: monad project post "你好！"',
      source: 'codex-exec',
      providerEventType: 'permission_denial'
    }
  ]);
});

test('native CLI stream-json events are projected as readable observation items', () => {
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

  const [stream] = __workplaceProjectMessageTest.buildNativeCliStreams(
    [],
    [
      {
        id: 'ncli_stream_events',
        av: 'CO',
        agentName: 'claude-code',
        tool: 'native-cli:claude-code',
        detail: 'native-cli:claude-code',
        output,
        status: 'running'
      }
    ]
  );

  expect(observationFields(stream.items)).toEqual([
    {
      id: 'ncli_stream_events:json:0:message:0',
      role: 'agent',
      text: 'I can help.',
      source: 'claude-code-sdk',
      providerEventType: 'assistant'
    },
    {
      id: 'ncli_stream_events:json:0:tool:1',
      role: 'tool',
      text: 'Tool call Bash',
      source: 'claude-code-sdk',
      providerEventType: 'assistant'
    },
    {
      id: 'ncli_stream_events:json:1:delta',
      role: 'agent',
      text: 'Streaming text.',
      source: 'claude-code-sdk',
      providerEventType: 'content_block_delta'
    },
    {
      id: 'ncli_stream_events:json:2:tool-result',
      role: 'tool',
      text: 'command output',
      source: 'claude-code-sdk',
      providerEventType: 'tool_result'
    },
    {
      id: 'ncli_stream_events:json:3:result',
      role: 'agent',
      text: 'Done.',
      source: 'claude-code-sdk',
      providerEventType: 'result'
    }
  ]);
});

test('native CLI projection ignores startup prose before stream-json objects', () => {
  const output = [
    'started claude-code in /Users/zeke/.monad/workplace-agents/project/claude-code',
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session' }),
    JSON.stringify({ type: 'result', result: 'Need approval before posting.' })
  ].join('');

  const [stream] = __workplaceProjectMessageTest.buildNativeCliStreams(
    [],
    [
      {
        id: 'ncli_mixed_claude',
        av: 'CL',
        agentName: 'claude-code',
        tool: 'native-cli:claude-code',
        detail: 'native-cli:claude-code',
        output,
        status: 'running'
      }
    ]
  );

  expect(observationFields(stream.items)).toEqual([
    {
      id: 'ncli_mixed_claude:json:0:system',
      role: 'system',
      text: 'init',
      source: 'claude-code-sdk',
      providerEventType: 'system'
    },
    {
      id: 'ncli_mixed_claude:json:1:result',
      role: 'agent',
      text: 'Need approval before posting.',
      source: 'claude-code-sdk',
      providerEventType: 'result'
    }
  ]);
  expect(stream.items.map((item) => item.text).join('\n')).not.toContain('started claude-code');
});

test('native CLI app-server JSON-RPC output is projected as readable observation items', () => {
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

  const [stream] = __workplaceProjectMessageTest.buildNativeCliStreams(
    [],
    [
      {
        id: 'ncli_app_server_codex',
        av: 'CO',
        agentName: 'test',
        tool: 'native-cli:codex',
        detail: 'native-cli:codex',
        output,
        status: 'running'
      }
    ]
  );

  expect(observationFields(stream.items)).toEqual([
    {
      id: 'ncli_app_server_codex:json:0:thread-started',
      role: 'system',
      text: 'Thread started in /Users/zeke/.codex/worktrees/28ea/monad/.dev/.monad/workplace-agents/project/test',
      source: 'codex-app-server',
      providerEventType: 'thread/started'
    },
    {
      id: 'ncli_app_server_codex:json:1:mcp-status',
      role: 'tool',
      text: 'node_repl starting',
      source: 'codex-app-server',
      providerEventType: 'mcpServer/startupStatus/updated'
    }
  ]);
  expect(stream.items.map((item) => item.text).join('\n')).not.toContain('"method"');
});

test('native CLI follow streams restore persisted terminal snapshots', () => {
  const [stream] = __workplaceProjectMessageTest.buildNativeCliStreams(
    [nativeCliSession({ outputSnapshot: '\\x1b[38;2;255;193;7mraw terminal output' })],
    []
  );

  expect(stream).toMatchObject({
    id: 'ncli_01KWGEMINI000000000000000',
    output: '\\x1b[38;2;255;193;7mraw terminal output',
    items: [
      {
        id: 'ncli_01KWGEMINI000000000000000:0',
        role: 'agent',
        source: 'plain-text',
        text: '\\x1b[38;2;255;193;7mraw terminal output'
      }
    ]
  });
});

test('native CLI resume failure is visible as a project system message', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    nativeCliSessions: [],
    liveItems: [
      {
        kind: 'system',
        id: 'native-cli-resume-failed:codex',
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
      id: 'native-cli-resume-failed:codex',
      authorName: 'codex',
      kind: 'system',
      tag: 'CLI',
      text: 'Codex resume failed for provider session codex-thread-stale; cold started a new runtime.',
      orderKey: 'evt_resume_failed'
    })
  ]);
});

test('native CLI project member presence treats spawned runtime as online until it generates', () => {
  expect(
    __workplaceProjectMessageTest.nativeCliMemberPresence({
      agentName: 'gemini',
      enabled: true,
      nativeCliSessions: [],
      liveTools: []
    })
  ).toBe('online');

  expect(
    __workplaceProjectMessageTest.nativeCliMemberPresence({
      agentName: 'gemini',
      enabled: true,
      nativeCliSessions: [],
      liveTools: [
        {
          id: 'tool_observation',
          kind: 'tool',
          tool: 'native-cli:gemini',
          input: { agent: 'gemini' },
          output: 'provider runtime output',
          status: 'running',
          seq: '002'
        } as never
      ]
    })
  ).toBe('online');

  expect(
    __workplaceProjectMessageTest.nativeCliMemberPresence({
      agentName: 'gemini',
      enabled: true,
      nativeCliSessions: [],
      liveTools: [
        {
          id: 'tool_login',
          kind: 'tool',
          tool: 'native-cli:gemini',
          input: { agent: 'gemini' },
          output: 'connection_required: sign in',
          status: 'running',
          seq: '003'
        } as never
      ]
    })
  ).toBe('needs-login');

  expect(
    __workplaceProjectMessageTest.nativeCliMemberPresence({
      agentName: 'gemini',
      enabled: true,
      nativeCliSessions: [nativeCliSession({ state: 'failed', outputSnapshot: 'process exited 1' })],
      liveTools: []
    })
  ).toBe('failed');

  expect(
    __workplaceProjectMessageTest.nativeCliMemberPresence({
      agentName: 'gemini',
      enabled: true,
      nativeCliSessions: [nativeCliSession({ state: 'stopped' })],
      liveTools: []
    })
  ).toBe('online');
});

test('native CLI project member presence treats lifecycle tools as stand-by availability', () => {
  expect(
    __workplaceProjectMessageTest.nativeCliMemberPresence({
      agentName: 'gemini',
      enabled: true,
      nativeCliSessions: [],
      liveTools: [
        {
          id: 'ncli_session',
          kind: 'tool',
          tool: 'native-cli:gemini',
          input: { agent: 'gemini' },
          status: 'running',
          seq: '002'
        } as never
      ]
    })
  ).toBe('online');
});

test('native CLI project member presence treats streaming managed messages as active generation', () => {
  expect(
    __workplaceProjectMessageTest.nativeCliMemberPresence({
      agentName: 'gemini',
      enabled: true,
      nativeCliSessions: [],
      liveTools: [],
      activeAgentNames: new Set(['gemini'])
    })
  ).toBe('working');
});

test('native CLI project member presence shows running sessions with provider approvals as working', () => {
  expect(
    __workplaceProjectMessageTest.nativeCliMemberPresence({
      agentName: 'gemini',
      enabled: true,
      nativeCliSessions: [
        nativeCliSession({
          pendingApprovalCount: 1
        } as Partial<NativeCliSessionView> & { pendingApprovalCount: number })
      ],
      liveTools: []
    })
  ).toBe('working');
});

test('native CLI project member presence is scoped by managed member instance id', () => {
  expect(
    __workplaceProjectMessageTest.nativeCliMemberPresence({
      agentName: 'pmem_codex_reviewer',
      enabled: true,
      nativeCliSessions: [],
      liveTools: [
        {
          id: 'tool_other_codex',
          kind: 'tool',
          tool: 'native-cli:codex',
          input: { agent: 'pmem_codex_writer' },
          status: 'running',
          seq: '002'
        } as never
      ]
    })
  ).toBe('online');

  expect(
    __workplaceProjectMessageTest.nativeCliMemberPresence({
      agentName: 'pmem_codex_reviewer',
      enabled: true,
      nativeCliSessions: [],
      liveTools: [],
      activeAgentNames: new Set(['pmem_codex_reviewer'])
    })
  ).toBe('working');
});

test('native CLI project members default to managed project runtime', () => {
  expect(
    __workplaceProjectMessageTest.defaultProjectMemberSettings('native-cli', {
      defaultLaunchMode: 'pty'
    })
  ).toEqual({
    launchMode: 'pty',
    managedProjectAgent: true
  });
});

test('native CLI project members preserve template and instance identity', () => {
  const [member] = __workplaceProjectMessageTest.parseProjectMembers([
    {
      type: 'native-cli',
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
    type: 'native-cli',
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

test('native CLI product display names use official client names', () => {
  expect(__workplaceProjectMessageTest.nativeCliProductDisplayName('codex', 'codex', 'codex')).toBe('OpenAI Codex');
  expect(__workplaceProjectMessageTest.nativeCliProductDisplayName('claude-code', 'claude-code', 'claude-code')).toBe(
    'Claude Code'
  );
  expect(__workplaceProjectMessageTest.nativeCliProductDisplayName('gemini', 'gemini', 'gemini')).toBe('Gemini CLI');
  expect(__workplaceProjectMessageTest.nativeCliProductDisplayName('qwen', 'qwen', 'qwen')).toBe('Qwen Code');
});

test('native CLI project member rename preserves runtime identity fields', () => {
  const member = __workplaceProjectMessageTest.renameNativeCliProjectMemberDisplayName(
    {
      id: 'pmem_codex_reviewer',
      type: 'native-cli',
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
    type: 'native-cli',
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
  expect(__workplaceProjectMessageTest.entityAvatarWriteUrl('Felix754865')).toBe(`${url}&write=1`);
  expect(__workplaceProjectMessageTest.avatarCacheKey('user:Operator')).not.toBe(
    __workplaceProjectMessageTest.avatarCacheKey('user:Renamed')
  );
  expect(
    __workplaceProjectMessageTest.nativeCliSessionMessage(nativeCliSession({ agentName: 'codex-reviewer' }))
  ).toMatchObject({
    avatarUrl: __workplaceProjectMessageTest.entityAvatarUrl('native-cli:codex-reviewer'),
    agentChip: {
      avatarUrl: __workplaceProjectMessageTest.entityAvatarUrl('native-cli:codex-reviewer')
    }
  });
});

test('native CLI system and assistant messages share the same instance avatar url', () => {
  const avatarUrl = __workplaceProjectMessageTest.entityAvatarUrl('native-cli-instance:reviewer');
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    nativeCliSessions: [
      nativeCliSession({ agentName: 'pmem_codex_reviewer', productIcon: 'codex', provider: 'codex' })
    ],
    liveItems: [
      {
        id: 'msg_reply',
        kind: 'message',
        role: 'assistant',
        agentName: 'pmem_codex_reviewer',
        source: 'managed-native-cli',
        parts: [{ type: 'text', text: 'Done' }],
        status: 'complete',
        seq: '002'
      }
    ] as never,
    liveTools: [],
    nativeCliDisplayNames: new Map([['pmem_codex_reviewer', 'Reviewer']]),
    nativeCliAvatarSeeds: new Map([['Reviewer', 'native-cli-instance:reviewer']])
  });

  const joined = messages.find((message) => message.id.startsWith('native-cli-session:'));
  const reply = messages.find((message) => message.id === 'msg_reply');

  expect(joined?.avatarUrl).toBe(avatarUrl);
  expect(joined?.agentChip?.avatarUrl).toBe(avatarUrl);
  expect(reply?.avatarUrl).toBe(avatarUrl);
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
