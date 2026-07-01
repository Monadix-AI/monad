import type { NativeCliSessionView } from '@monad/protocol';
import type { Message } from '../../features/workplace/types.ts';

import { expect, test } from 'bun:test';

import { __workplaceProjectMessageTest } from '../../features/workplace/use-project.ts';

const nativeCliSession = (overrides: Partial<NativeCliSessionView> = {}): NativeCliSessionView => ({
  id: 'ncli_01KWGEMINI000000000000000',
  projectSessionId: 'ses_01KWPROJECT00000000000000',
  agentName: 'gemini',
  provider: 'gemini',
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

test('native CLI sessions project to durable chat messages', () => {
  const message = __workplaceProjectMessageTest.nativeCliSessionMessage(nativeCliSession());

  expect(message).toMatchObject({
    id: 'native-cli-session:ncli_01KWGEMINI000000000000000',
    authorName: 'gemini',
    icon: 'google',
    kind: 'system',
    tag: 'Gemini',
    text: 'joined the project',
    agentChip: {
      id: 'native-cli:gemini',
      name: 'gemini',
      icon: 'google',
      tag: 'Gemini'
    },
    nativeCliSessionId: 'ncli_01KWGEMINI000000000000000',
    streaming: false,
    orderKey: '2026-06-29T10:00:00.000Z'
  });
  expect(message.text).not.toContain('/Users/zeke/Projects/monad');
});

test('native CLI developer messages keep raw launch details separate', () => {
  const message = __workplaceProjectMessageTest.nativeCliSessionDeveloperMessage(nativeCliSession());

  expect(message).toMatchObject({
    id: 'native-cli-session-developer:ncli_01KWGEMINI000000000000000',
    kind: 'developer',
    tag: 'DEV',
    text: 'started gemini in /Users/zeke/Projects/monad',
    nativeCliSessionId: 'ncli_01KWGEMINI000000000000000',
    developerOnly: true,
    orderKey: '2026-06-29T10:00:00.000Z:developer'
  });
});

test('native CLI durable sessions keep timeline populated after live tool settles', () => {
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    nativeCliSessions: [nativeCliSession()],
    liveItems: [],
    liveTools: [],
    showDeveloperOnlyMessages: false
  });

  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    id: 'native-cli-session:ncli_01KWGEMINI000000000000000',
    authorName: 'gemini',
    kind: 'system',
    text: 'joined the project',
    agentChip: { id: 'native-cli:gemini', name: 'gemini' }
  });
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
    status: 'running'
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

test('native CLI project member presence reflects managed runtime state', () => {
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
          id: 'tool_working',
          kind: 'tool',
          tool: 'native-cli:gemini',
          input: { agent: 'gemini' },
          status: 'running',
          seq: '002'
        } as never
      ]
    })
  ).toBe('working');

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
  ).toBe('stopped');
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
