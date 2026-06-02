// Inbound normalization conformance for the Discord adapter. Channel/renderer-level behaviour is
// exercised in apps/monad against a mock adapter; here we pin the payload→ChannelInbound rules.

import { expect, test } from 'bun:test';

import { normalizeDiscordMessage } from '../../src/channels/discord.ts';

test('D1: a DM (no guild_id) → chatType dm; guild → group', () => {
  expect(normalizeDiscordMessage({ id: '1', channel_id: 'c', author: { id: 'u' }, content: 'hi' }).chatType).toBe('dm');
  expect(
    normalizeDiscordMessage({ id: '1', channel_id: 'c', guild_id: 'g', author: { id: 'u' }, content: 'hi' }).chatType
  ).toBe('group');
});

test('D2: a leading / is a command (lowercased) with args', () => {
  const ev = normalizeDiscordMessage({ id: '1', channel_id: 'c', author: { id: 'u' }, content: '/New foo bar' });
  expect(ev.kind).toBe('command');
  expect(ev.command).toBe('new');
  expect(ev.commandArgs).toEqual(['foo', 'bar']);
});

test('D3: mentionedSelf from the mentions array or a reply to the bot', () => {
  const mention = normalizeDiscordMessage(
    { id: '1', channel_id: 'c', guild_id: 'g', author: { id: 'u' }, content: '<@42> hi', mentions: [{ id: '42' }] },
    '42'
  );
  expect(mention.mentionedSelf).toBe(true);
  const reply = normalizeDiscordMessage(
    {
      id: '2',
      channel_id: 'c',
      guild_id: 'g',
      author: { id: 'u' },
      content: 'hi',
      referenced_message: { id: '9', author: { id: '42' } }
    },
    '42'
  );
  expect(reply.mentionedSelf).toBe(true);
  expect(reply.replyTo).toBe('9');
  const plain = normalizeDiscordMessage(
    { id: '3', channel_id: 'c', guild_id: 'g', author: { id: 'u' }, content: 'chatter' },
    '42'
  );
  expect(plain.mentionedSelf).toBe(false);
});

test('D4: isSelf set when the author is the bot', () => {
  const m = { id: '1', channel_id: 'c', author: { id: '42' }, content: 'x' };
  expect(normalizeDiscordMessage(m, '42').isSelf).toBe(true);
  expect(normalizeDiscordMessage(m, '7').isSelf).toBe(false);
});

test('D5: golden guild message → normalized fields', () => {
  expect(
    normalizeDiscordMessage(
      {
        id: '7',
        channel_id: 'chan',
        guild_id: 'guild',
        author: { id: '42', username: 'alice', global_name: 'Alice' },
        content: 'hello'
      },
      '999'
    )
  ).toMatchObject({
    chatId: 'chan',
    userId: '42',
    text: 'hello',
    kind: 'text',
    nativeMessageId: '7',
    senderDisplay: 'Alice',
    chatType: 'group',
    isSelf: false
  });
});
