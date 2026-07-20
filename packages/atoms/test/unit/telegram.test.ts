// Inbound normalization conformance: each case pins a specific rule (text XOR caption,
// command parsing, isSelf guard, etc.). Channel/renderer-level tests live in apps/monad.

import type { ChannelContext } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import { createTelegramAdapter, normalizeTelegramMessage } from '../../src/channels/telegram.ts';

function fakeContext(): ChannelContext {
  return {
    config: { type: 'telegram', options: {} } as ChannelContext['config'],
    log: () => {},
    onMessage: () => {},
    secrets: { token: 'test-token' },
    signal: new AbortController().signal
  } as ChannelContext;
}

test('A0: malformed Telegram responses are rejected at the channel boundary', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => Response.json({ ok: true, result: { id: 'not-a-number' } }), {
    preconnect: originalFetch.preconnect
  });
  try {
    await expect(createTelegramAdapter(fakeContext()).connect()).rejects.toThrow();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('A1: text wins over caption; caption used when no text; media-only → kind media', () => {
  expect(normalizeTelegramMessage({ message_id: 1, chat: { id: 5, type: 'private' }, text: 'hi' }).text).toBe('hi');
  const cap = normalizeTelegramMessage({ message_id: 1, chat: { id: 5, type: 'private' }, caption: 'c' });
  expect(cap.text).toBe('c');
  expect(cap.kind).toBe('text');
  expect(normalizeTelegramMessage({ message_id: 1, chat: { id: 5, type: 'private' } }).kind).toBe('media');
});

test('A2: command name strips leading /, strips @suffix, LOWERCASES; args follow', () => {
  const ev = normalizeTelegramMessage({ message_id: 1, chat: { id: 5, type: 'private' }, text: '/New@MyBot foo bar' });
  expect(ev.kind).toBe('command');
  expect(ev.command).toBe('new'); // lowercase + @MyBot stripped (matches both references)
  expect(ev.commandArgs).toEqual(['foo', 'bar']);
});

test('A3: isSelf is set when the sender is the bot itself (echo guard)', () => {
  const m = { message_id: 1, chat: { id: 5, type: 'private' }, from: { id: 999 }, text: 'x' };
  expect(normalizeTelegramMessage(m, '999').isSelf).toBe(true);
  expect(normalizeTelegramMessage(m, '111').isSelf).toBe(false);
});

test('A4: chatType maps private→dm, supergroup→group, channel→channel', () => {
  const at = (type: string) => normalizeTelegramMessage({ message_id: 1, chat: { id: 5, type }, text: 'x' }).chatType;
  expect(at('private')).toBe('dm');
  expect(at('group')).toBe('group');
  expect(at('supergroup')).toBe('group');
  expect(at('channel')).toBe('channel');
});

test('A5: mentionedSelf set on @username mention or reply-to-bot', () => {
  // @-mention entity matching the bot username.
  const mention = normalizeTelegramMessage(
    {
      message_id: 1,
      chat: { id: -1, type: 'supergroup' },
      from: { id: 9 },
      text: '@mybot hello',
      entities: [{ type: 'mention', offset: 0, length: 6 }]
    },
    '4242',
    'MyBot'
  );
  expect(mention.mentionedSelf).toBe(true);
  // Reply to the bot's own message.
  const reply = normalizeTelegramMessage(
    {
      message_id: 2,
      chat: { id: -1, type: 'supergroup' },
      from: { id: 9 },
      text: 'hi',
      reply_to_message: { message_id: 1, from: { id: 4242 } }
    },
    '4242',
    'MyBot'
  );
  expect(reply.mentionedSelf).toBe(true);
  // Plain group chatter is not addressed.
  const plain = normalizeTelegramMessage(
    { message_id: 3, chat: { id: -1, type: 'supergroup' }, from: { id: 9 }, text: 'unrelated' },
    '4242',
    'MyBot'
  );
  expect(plain.mentionedSelf).toBe(false);
});

test('A: golden supergroup/forum command payload → normalized fields', () => {
  // The matrix "test-ready" Telegram getUpdates example.
  const ev = normalizeTelegramMessage(
    {
      message_id: 7,
      chat: { id: -1001, type: 'supergroup' },
      from: { id: 42, username: 'alice', first_name: 'Alice' },
      message_thread_id: 77,
      text: '/status@MyBot now',
      reply_to_message: { message_id: 5 }
    },
    '4242'
  );
  expect(ev).toMatchObject({
    chatId: '-1001',
    userId: '42',
    threadId: '77',
    kind: 'command',
    command: 'status',
    commandArgs: ['now'],
    nativeMessageId: '7',
    replyTo: '5',
    senderDisplay: 'alice',
    isSelf: false
  });
});
