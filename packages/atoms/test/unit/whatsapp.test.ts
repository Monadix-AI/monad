import { expect, test } from 'bun:test';

import { normalizeWhatsappWebhook } from '../../src/channels/whatsapp.ts';

test('WA1: flattens entry→changes→messages text into inbounds (dm)', () => {
  const evs = normalizeWhatsappWebhook({
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
    normalizeWhatsappWebhook({
      entry: [{ changes: [{ value: { messages: [{ from: 'x', id: '1', type: 'image' }] } }] }]
    }).length
  ).toBe(0);
  const c = normalizeWhatsappWebhook({
    entry: [{ changes: [{ value: { messages: [{ from: 'x', id: '1', type: 'text', text: { body: '/new' } }] } }] }]
  });
  expect(c[0]).toMatchObject({ kind: 'command', command: 'new' });
});
