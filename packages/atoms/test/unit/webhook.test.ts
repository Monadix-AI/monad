// Inbound normalization conformance for the generic webhook adapter (untrusted HTTP payloads).

import { expect, test } from 'bun:test';

import { normalizeWebhookPayload } from '../../src/channels/webhook.ts';

test('W1: requires string chatId and userId', () => {
  expect(() => normalizeWebhookPayload({ chatId: 'c' }, 1)).toThrow();
  expect(() => normalizeWebhookPayload({ userId: 'u' }, 1)).toThrow();
  expect(() => normalizeWebhookPayload({ chatId: 1, userId: 2 }, 1)).toThrow();
});

test('W2: minimal payload normalizes; messageId defaults to a sequence', () => {
  const ev = normalizeWebhookPayload({ chatId: 'c', userId: 'u', text: 'hi' }, 7);
  expect(ev).toMatchObject({
    chatId: 'c',
    userId: 'u',
    text: 'hi',
    kind: 'text',
    nativeMessageId: 'wh-7',
    chatType: 'dm',
    isSelf: false
  });
});

test('W3: explicit messageId, chatType, threadId carry through', () => {
  const ev = normalizeWebhookPayload(
    { chatId: 'c', userId: 'u', text: 'x', messageId: 'm1', chatType: 'group', threadId: 't1', senderDisplay: 'Al' },
    1
  );
  expect(ev.nativeMessageId).toBe('m1');
  expect(ev.chatType).toBe('group');
  expect(ev.threadId).toBe('t1');
  expect(ev.senderDisplay).toBe('Al');
});

test('W4: a leading / is parsed as a command', () => {
  const ev = normalizeWebhookPayload({ chatId: 'c', userId: 'u', text: '/new Topic' }, 1);
  expect(ev.kind).toBe('command');
  expect(ev.command).toBe('new');
  expect(ev.commandArgs).toEqual(['Topic']);
});

test('W5: an unknown chatType falls back to dm', () => {
  expect(normalizeWebhookPayload({ chatId: 'c', userId: 'u', text: 'x', chatType: 'bogus' }, 1).chatType).toBe('dm');
});

test('W6: timingSafeEqual rejects mismatched length without short-circuiting', async () => {
  const { timingSafeEqual } = await import('../../src/channels/_http-inbound.ts');
  expect(timingSafeEqual('abc', 'abc')).toBe(true);
  expect(timingSafeEqual('abc', 'abd')).toBe(false);
  expect(timingSafeEqual('abc', 'ab')).toBe(false); // length mismatch → false, no early exit
  expect(timingSafeEqual('', '')).toBe(true);
  expect(timingSafeEqual('a', '')).toBe(false);
});
