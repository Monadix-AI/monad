import type { UIItem } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  enqueueInitialUserMessageForSession,
  getSessionUiStore,
  removeSessionUiStore,
  useSessionUiStore
} from '../../src/features/session/session-ui-store.ts';
import {
  createLatestRequestGuard,
  releaseReplyTargetRequests,
  replyTargetRequestIds,
  runLatestRequest
} from '../../src/hooks/use-transcript-history.ts';

test('session UI stores isolate composer and interaction state by session instance', () => {
  const first = getSessionUiStore('ses_first');
  const second = getSessionUiStore('ses_second');

  first.getState().setComposerInput('draft A');
  second.getState().setComposerInput('draft B');
  first.getState().setReplyTargetId('msg_first_target');
  second.getState().setReplyTargetId('msg_second_target');
  removeSessionUiStore('ses_first');
  const recreated = getSessionUiStore('ses_first');

  expect({
    first: first.getState().input,
    recreated: recreated.getState().input,
    recreatedReply: recreated.getState().replyTargetId,
    second: second.getState().input,
    secondReply: second.getState().replyTargetId
  }).toEqual({
    first: 'draft A',
    recreated: '',
    recreatedReply: null,
    second: 'draft B',
    secondReply: 'msg_second_target'
  });
});

test('initial user-message handoff keeps attachment previews until the real session consumes them', () => {
  const store = getSessionUiStore('ses_initial_attachment');
  enqueueInitialUserMessageForSession('ses_initial_attachment', {
    attachments: [
      {
        bytes: 3,
        createdAt: '2026-07-28T09:00:00.000Z',
        id: 'att_123456789012',
        imageSrc: 'data:image/png;base64,cG5n',
        mime: 'image/png',
        name: 'shot.png'
      }
    ],
    text: 'Use this image'
  });

  expect(store.getState().initialUserMessagesBySession.ses_initial_attachment).toEqual([
    {
      attachments: [
        {
          bytes: 3,
          createdAt: '2026-07-28T09:00:00.000Z',
          id: 'att_123456789012',
          imageSrc: 'data:image/png;base64,cG5n',
          mime: 'image/png',
          name: 'shot.png'
        }
      ],
      text: 'Use this image'
    }
  ]);
  expect(useSessionUiStore.getState().initialUserMessagesBySession.ses_initial_attachment).toBeUndefined();
});

test('canceling a reply clears only reply state and keeps the composer draft', () => {
  const store = getSessionUiStore('ses_reply_cancel');
  store.getState().setComposerInput('Typed response');
  store.getState().setReplyTargetId('msg_target');

  store.getState().setReplyTargetId(null);

  expect({ input: store.getState().input, replyTargetId: store.getState().replyTargetId }).toEqual({
    input: 'Typed response',
    replyTargetId: null
  });
});

test('an older send completion cannot clear a same-target reply selected again', () => {
  const store = getSessionUiStore('ses_reply_generation');
  store.getState().setReplyTargetId('msg_target');
  const firstGeneration = store.getState().replyGeneration;

  store.getState().setReplyTargetId('msg_target');
  const secondGeneration = store.getState().replyGeneration;
  store.getState().finishReplySend(firstGeneration, true);
  const afterOlderCompletion = store.getState().replyTargetId;
  store.getState().finishReplySend(secondGeneration, true);

  expect({ afterOlderCompletion, final: store.getState().replyTargetId }).toEqual({
    afterOlderCompletion: 'msg_target',
    final: null
  });
});

test('a slash command with no persisted message keeps the active reply draft', () => {
  const store = getSessionUiStore('ses_reply_command_no_message');
  store.getState().setReplyTargetId('msg_target');
  const generation = store.getState().replyGeneration;

  store.getState().finishReplySend(generation, false);

  expect(store.getState().replyTargetId).toBe('msg_target');
});

test('reply selection stores identity and generation without retaining target content', () => {
  const store = getSessionUiStore('ses_reply_identity_only');
  store.getState().setReplyTargetId('msg_target');

  expect({
    generation: store.getState().replyGeneration,
    keys: Object.keys(store.getState())
      .filter((key) => key.startsWith('reply'))
      .sort(),
    targetId: store.getState().replyTargetId
  }).toEqual({
    generation: 1,
    keys: ['replyGeneration', 'replyTargetId'],
    targetId: 'msg_target'
  });
});

test('reply target resolution batches only missing visible targets and stays bounded', () => {
  const visibleItems: UIItem[] = Array.from({ length: 105 }, (_, index) => ({
    id: `msg_reply_${index}`,
    kind: 'message' as const,
    parts: [{ type: 'text' as const, text: `Reply ${index}` }],
    replyToMessageId: `msg_target_${index}` as `msg_${string}`,
    replyable: true,
    role: 'assistant' as const,
    seq: `${index}`
  }));
  visibleItems.push({
    id: 'msg_target_0',
    kind: 'message',
    parts: [{ type: 'text', text: 'Visible target' }],
    replyToMessageId: undefined,
    replyable: true,
    role: 'user',
    seq: 'visible-target'
  });
  const lookup = new Map([['msg_target_1', null]]);

  const requestIds = replyTargetRequestIds(visibleItems, lookup);

  expect({
    first: requestIds[0],
    includesKnown: requestIds.includes('msg_target_1'),
    length: requestIds.length
  }).toEqual({
    first: 'msg_target_2',
    includesKnown: false,
    length: 100
  });
});

test('failed reply target lookups are released so the target can be retried', () => {
  const requested = new Set(['msg_failed', 'msg_active']);
  const released = releaseReplyTargetRequests(requested, ['msg_failed']);
  const visibleItems: UIItem[] = [
    {
      id: 'msg_reply',
      kind: 'message',
      parts: [{ type: 'text', text: 'Reply' }],
      replyToMessageId: 'msg_failed',
      replyable: true,
      role: 'assistant',
      seq: '1'
    }
  ];

  expect({ released: [...released], retry: replyTargetRequestIds(visibleItems, new Map(), released) }).toEqual({
    released: ['msg_active'],
    retry: ['msg_failed']
  });
});

test('only the latest transcript navigation request may install its result', async () => {
  const guard = createLatestRequestGuard();
  let resolveA: (() => void) | undefined;
  let resolveB: (() => void) | undefined;
  const requestA = new Promise<void>((resolve) => {
    resolveA = resolve;
  });
  const requestB = new Promise<void>((resolve) => {
    resolveB = resolve;
  });
  const installed: string[] = [];
  const a = runLatestRequest(
    guard,
    () => requestA,
    () => installed.push('A')
  );
  const b = runLatestRequest(
    guard,
    () => requestB,
    () => installed.push('B')
  );
  resolveB?.();
  await b;
  resolveA?.();
  await a;

  expect(installed).toEqual(['B']);
});

test('applyCommandInsert replaces the active token when a range is provided', () => {
  useSessionUiStore.setState({ input: '/me' });
  useSessionUiStore.getState().applyCommandInsert({
    insert: '/memory ',
    replace: { start: 0, end: 3 }
  });
  expect(useSessionUiStore.getState().input).toBe('/memory ');
});

test('applyCommandInsert keeps append behavior for items without a replacement range', () => {
  useSessionUiStore.setState({ input: 'hello ' });
  useSessionUiStore.getState().applyCommandInsert({ insert: '/skill ' });
  expect(useSessionUiStore.getState().input).toBe('hello /skill ');
});

test('applyCommandInsert replaces a partially typed subcommand', () => {
  useSessionUiStore.setState({ input: '/memory c' });
  useSessionUiStore.getState().applyCommandInsert({
    insert: '/memory check ',
    replace: { start: 0, end: 9 }
  });
  expect(useSessionUiStore.getState().input).toBe('/memory check ');
});

test('applyCommandInsert replaces a partially typed subcommand argument', () => {
  useSessionUiStore.setState({ input: '/memory consolidate 3' });
  useSessionUiStore.getState().applyCommandInsert({
    insert: '/memory consolidate 1',
    replace: { start: 0, end: 21 }
  });
  expect(useSessionUiStore.getState().input).toBe('/memory consolidate 1');
});
