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
  state: 'running',
  pid: 1234,
  providerSessionRef: null,
  outputSnapshot: '',
  exitCode: null,
  startedAt: '2026-06-29T10:00:00.000Z',
  updatedAt: '2026-06-29T10:00:00.000Z',
  exitedAt: null,
  ...overrides
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
