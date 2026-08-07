import type { ChannelOriginLabels } from '@monad/ui';

import { expect, test } from 'bun:test';

import { messageSentFrom } from '../../src/features/session/message-sent-from';

const labels: ChannelOriginLabels = {
  conversation: 'Conversation',
  directMessage: 'Direct message',
  group: 'Group',
  channel: 'Channel',
  sender: 'Sender',
  thread: 'Thread',
  instance: 'Connection',
  version: 'Version'
};

const channelOptions = [{ type: 'telegram', label: 'Telegram' }];

test('a channel-delivered message reads back its conversation and sender in human terms', () => {
  expect(
    messageSentFrom(
      {
        transport: 'channel',
        surface: 'im',
        client: 'telegram',
        instanceId: 'tg-main',
        senderId: 'user-42',
        senderDisplay: 'Ada',
        chatTitle: 'Dev Team',
        chatType: 'group',
        threadId: 'topic-7'
      },
      channelOptions,
      labels
    )
  ).toEqual({
    label: 'Telegram',
    details: [
      { label: 'Conversation', value: 'Dev Team · Group' },
      { label: 'Sender', value: 'Ada' },
      { label: 'Thread', value: 'topic-7' },
      { label: 'Connection', value: 'tg-main' }
    ]
  });
});

test('platform ids stand in only where the adapter reported no readable name', () => {
  const resolved = messageSentFrom(
    { transport: 'channel', surface: 'im', client: 'telegram', senderId: 'user-42', chatType: 'dm' },
    channelOptions,
    labels
  );
  expect(resolved?.details).toEqual([
    { label: 'Conversation', value: 'Direct message' },
    { label: 'Sender', value: 'user-42' }
  ]);
});

test('a web reply carries a bare http origin and shows no badge', () => {
  expect(messageSentFrom({ transport: 'http' }, channelOptions, labels)).toBeUndefined();
});

test('a legacy row without a persisted origin gets no badge — provenance is never guessed', () => {
  expect(messageSentFrom(undefined, channelOptions, labels)).toBeUndefined();
});

test('web-surface origins never produce a badge', () => {
  expect(
    messageSentFrom({ transport: 'http', surface: 'web', client: 'monad-web' }, channelOptions, labels)
  ).toBeUndefined();
});

test('an unknown channel type still badges with its raw client name', () => {
  expect(messageSentFrom({ transport: 'channel', surface: 'im', client: 'slack' }, [], labels)?.label).toBe('slack');
});
