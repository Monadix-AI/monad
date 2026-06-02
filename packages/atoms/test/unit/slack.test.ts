// Inbound normalization conformance for the Slack adapter (Socket Mode message events).

import { expect, test } from 'bun:test';

import { normalizeSlackMessage } from '../../src/channels/slack.ts';

test('S1: channel_type maps im→dm, channel→channel, mpim/group→group', () => {
  const at = (channel_type: string) =>
    normalizeSlackMessage({ type: 'message', channel: 'C', user: 'U', ts: '1', text: 'x', channel_type }).chatType;
  expect(at('im')).toBe('dm');
  expect(at('channel')).toBe('channel');
  expect(at('mpim')).toBe('group');
  expect(at('group')).toBe('group');
});

test('S2: ts is the native message id; thread_ts is threadId', () => {
  const ev = normalizeSlackMessage({
    type: 'message',
    channel: 'C',
    user: 'U',
    ts: '1700.001',
    thread_ts: '1699.999',
    text: 'hi'
  });
  expect(ev.nativeMessageId).toBe('1700.001');
  expect(ev.threadId).toBe('1699.999');
});

test('S3: mentionedSelf from the <@U…> token', () => {
  const ev = normalizeSlackMessage(
    { type: 'message', channel: 'C', user: 'U', ts: '1', text: 'hey <@UBOT> ping', channel_type: 'channel' },
    'UBOT'
  );
  expect(ev.mentionedSelf).toBe(true);
  const plain = normalizeSlackMessage(
    { type: 'message', channel: 'C', user: 'U', ts: '1', text: 'chatter', channel_type: 'channel' },
    'UBOT'
  );
  expect(plain.mentionedSelf).toBe(false);
});

test('S4: isSelf set for the bot user id or any bot_id (echo guard)', () => {
  expect(
    normalizeSlackMessage({ type: 'message', channel: 'C', user: 'UBOT', ts: '1', text: 'x' }, 'UBOT').isSelf
  ).toBe(true);
  expect(
    normalizeSlackMessage({ type: 'message', channel: 'C', ts: '1', text: 'x', bot_id: 'B1' }, 'UBOT').isSelf
  ).toBe(true);
  expect(normalizeSlackMessage({ type: 'message', channel: 'C', user: 'U2', ts: '1', text: 'x' }, 'UBOT').isSelf).toBe(
    false
  );
});

test('S5: leading / is a command', () => {
  const ev = normalizeSlackMessage({
    type: 'message',
    channel: 'C',
    user: 'U',
    ts: '1',
    text: '/Reset now',
    channel_type: 'im'
  });
  expect(ev.kind).toBe('command');
  expect(ev.command).toBe('reset');
  expect(ev.commandArgs).toEqual(['now']);
});
