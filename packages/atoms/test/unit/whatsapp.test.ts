import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizeWhatsappSocketMessage,
  normalizeWhatsappWebMessage,
  sendWhatsappWelcomeOnce
} from '../../src/channels/whatsapp.ts';
import { normalizeWhatsappBusinessWebhook } from '../../src/channels/whatsapp-business.ts';

test('WA1: flattens entry→changes→messages text into inbounds (dm)', () => {
  const evs = normalizeWhatsappBusinessWebhook({
    entry: [
      { changes: [{ value: { messages: [{ from: '15551234', id: 'wamid.1', type: 'text', text: { body: 'hi' } }] } }] }
    ]
  });
  expect(evs.length).toBe(1);
  expect(evs[0]).toMatchObject({
    chatId: '15551234',
    userId: '15551234',
    text: 'hi',
    chatType: 'dm',
    nativeMessageId: 'wamid.1'
  });
});

test('WA2: non-text messages are skipped; command parse', () => {
  expect(
    normalizeWhatsappBusinessWebhook({
      entry: [{ changes: [{ value: { messages: [{ from: 'x', id: '1', type: 'image' }] } }] }]
    }).length
  ).toBe(0);
  const c = normalizeWhatsappBusinessWebhook({
    entry: [{ changes: [{ value: { messages: [{ from: 'x', id: '1', type: 'text', text: { body: '/new' } }] } }] }]
  });
  expect(c[0]).toMatchObject({ kind: 'command', command: 'new' });
});

test('WA3: normalizes linked-device DMs and group commands', () => {
  expect(
    normalizeWhatsappWebMessage({
      key: { remoteJid: '120363@g.us', participant: '15551234@s.whatsapp.net', id: 'web.1' },
      pushName: 'Ada',
      message: { extendedTextMessage: { text: '/new', contextInfo: { mentionedJid: ['bot@s.whatsapp.net'] } } }
    })
  ).toEqual({
    chatId: '120363@g.us',
    userId: '15551234@s.whatsapp.net',
    text: '/new',
    kind: 'command',
    command: 'new',
    commandArgs: [],
    nativeMessageId: 'web.1',
    senderDisplay: 'Ada',
    chatType: 'group',
    mentionedSelf: true,
    isSelf: false,
    media: [],
    at: expect.any(String)
  });
});

test('WA4: accepts user-authored self-chat messages but drops Monad echoes and other outgoing chats', () => {
  const ownMessageIds = new Set(['monad.1']);
  const selfMessage = (id: string, remoteJid = '15550001@s.whatsapp.net') => ({
    key: { remoteJid, fromMe: true, id },
    pushName: 'Ada',
    message: { conversation: 'hello' }
  });

  expect(
    normalizeWhatsappSocketMessage(selfMessage('user.1'), ['987654321@lid', '15550001:7@s.whatsapp.net'], ownMessageIds)
  ).toEqual({
    chatId: '15550001@s.whatsapp.net',
    userId: '15550001@s.whatsapp.net',
    text: 'hello',
    kind: 'text',
    command: undefined,
    commandArgs: [],
    nativeMessageId: 'user.1',
    senderDisplay: 'Ada',
    chatType: 'dm',
    mentionedSelf: false,
    isSelf: false,
    media: [],
    at: expect.any(String)
  });
  expect(normalizeWhatsappSocketMessage(selfMessage('monad.1'), ['15550001@s.whatsapp.net'], ownMessageIds)).toBeNull();
  expect(
    normalizeWhatsappSocketMessage(
      selfMessage('user.2', '15550002@s.whatsapp.net'),
      ['15550001@s.whatsapp.net'],
      ownMessageIds
    )
  ).toBeNull();
  expect(ownMessageIds).toEqual(new Set());
});

test('WA5: sends the connected welcome once per persisted channel state', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'monad-whatsapp-welcome-'));
  const sends: Array<{ chatId: string; content: string }> = [];
  const args = {
    stateDir,
    chatId: '15550001@s.whatsapp.net',
    content: 'Monad connected',
    send: async (chatId: string, content: string) => {
      sends.push({ chatId, content });
    }
  };

  try {
    expect(await sendWhatsappWelcomeOnce(args)).toBe(true);
    expect(await sendWhatsappWelcomeOnce(args)).toBe(false);
    expect(sends).toEqual([{ chatId: '15550001@s.whatsapp.net', content: 'Monad connected' }]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
