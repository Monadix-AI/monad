import { expect, mock, test } from 'bun:test';

import { deferredEffortCommit } from '../../src/components/ReasoningEffortControl.tsx';
import { composerReasoningEffortOptions } from '../../src/features/session/ComposerShell.tsx';
import { sessionMessagesCanSteer } from '../../src/features/session/session-route-contract.ts';
import {
  completeReplySend,
  drainSessionMessageQueue,
  parseComposerSlashCommand,
  removeSessionQueuedMessage
} from '../../src/hooks/use-chat-composer.ts';

const fileAttachment = {
  kind: 'file-meta' as const,
  mediaType: 'application/zip',
  name: 'bundle.zip',
  size: 2048
};

test('composer effort control can restore the profile or model default on close', () => {
  const onEffortChange = mock((_effort?: string) => {});
  const options = composerReasoningEffortOptions(['low', 'medium', 'high'], 'Default');

  expect(options.map((option) => option.value)).toEqual([undefined, 'low', 'medium', 'high']);
  const commit = deferredEffortCommit(false, 'high', options[0]?.value);
  if (commit) onEffortChange(commit.value);
  expect(onEffortChange).toHaveBeenCalledWith(undefined);
});

test('reply send completion runs only after the asynchronous send settles', async () => {
  let resolveSend: ((value: boolean) => void) | undefined;
  const send = new Promise<boolean>((resolve) => {
    resolveSend = resolve;
  });
  const finish = mock((_succeeded: boolean) => {});
  const completion = completeReplySend(() => send, finish);

  expect(finish).not.toHaveBeenCalled();
  resolveSend?.(true);
  expect(await completion).toBe(true);
  expect(finish).toHaveBeenCalledWith(true);
});

test('session queue drain preserves one shared reply edge', () => {
  expect(
    drainSessionMessageQueue([
      { text: 'first', replyToMessageId: 'msg_target', replyGeneration: 4 },
      { text: 'second', replyToMessageId: 'msg_target', replyGeneration: 4 }
    ])
  ).toEqual({
    next: { text: 'first\n\nsecond', replyToMessageId: 'msg_target', replyGeneration: 4 },
    remaining: []
  });
});

test('session queue drain keeps different reply targets as separate sends', () => {
  expect(
    drainSessionMessageQueue([
      { text: 'first', replyToMessageId: 'msg_a', replyGeneration: 1 },
      { text: 'second', replyToMessageId: 'msg_b', replyGeneration: 2 }
    ])
  ).toEqual({
    next: { text: 'first', replyToMessageId: 'msg_a', replyGeneration: 1 },
    remaining: [{ text: 'second', replyToMessageId: 'msg_b', replyGeneration: 2 }]
  });
});

test('session queue drain keeps ordinary text after a reply for a later send', () => {
  expect(
    drainSessionMessageQueue([
      { text: 'reply', replyToMessageId: 'msg_target', replyGeneration: 1 },
      { text: 'ordinary' }
    ])
  ).toEqual({
    next: { text: 'reply', replyToMessageId: 'msg_target', replyGeneration: 1 },
    remaining: [{ text: 'ordinary' }]
  });
});

test('session queue drain keeps attachment ownership on an individual send', () => {
  expect(drainSessionMessageQueue([{ text: 'first', attachments: [fileAttachment] }, { text: 'second' }])).toEqual({
    next: { text: 'first', attachments: [fileAttachment] },
    remaining: [{ text: 'second' }]
  });
});

test('removing a queued reply removes its relation ownership before drain', () => {
  const queue = [{ text: 'reply', replyToMessageId: 'msg_target', replyGeneration: 1 }, { text: 'ordinary' }];

  expect(drainSessionMessageQueue(removeSessionQueuedMessage(queue, 0))).toEqual({
    next: { text: 'ordinary' },
    remaining: []
  });
});

test('steer accepts only queues whose items have no reply relation', () => {
  expect({
    attachment: sessionMessagesCanSteer([{ text: 'ordinary', attachments: [fileAttachment] }]),
    ordinary: sessionMessagesCanSteer([{ text: 'ordinary' }, { text: 'another' }]),
    reply: sessionMessagesCanSteer([
      { text: 'ordinary' },
      { text: 'reply', replyToMessageId: 'msg_target', replyGeneration: 3 }
    ])
  }).toEqual({ attachment: false, ordinary: true, reply: false });
});

test('attachments keep slash-prefixed text on the normal message path', () => {
  expect({
    attachment: parseComposerSlashCommand('/compact', [fileAttachment])?.name ?? null,
    textOnly: parseComposerSlashCommand('/compact', [])?.name ?? null
  }).toEqual({ attachment: null, textOnly: 'compact' });
});
