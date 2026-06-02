import { expect, test } from 'bun:test';

import { normalizeTwilioForm, twilioSignature } from '../../src/channels/twilio.ts';

test('TW1: form params normalize; sender is chat + user (dm)', () => {
  const ev = normalizeTwilioForm(
    new URLSearchParams({ From: '+15551234', To: '+15550000', Body: 'hi', MessageSid: 'SM1' })
  );
  expect(ev).toMatchObject({
    chatId: '+15551234',
    userId: '+15551234',
    text: 'hi',
    nativeMessageId: 'SM1',
    chatType: 'dm'
  });
});

test('TW2: missing From → null; command parse', () => {
  expect(normalizeTwilioForm(new URLSearchParams({ Body: 'x' }))).toBe(null);
  expect(normalizeTwilioForm(new URLSearchParams({ From: 'a', Body: '/help' }))).toMatchObject({
    kind: 'command',
    command: 'help'
  });
});

test('TW3: signature is deterministic base64 over url + sorted params, key-sensitive + order-insensitive', async () => {
  const url = 'https://example.com/twilio';
  const a = await twilioSignature('tok', url, new URLSearchParams({ From: '+1', To: '+2', Body: 'hi' }));
  const b = await twilioSignature('tok', url, new URLSearchParams({ To: '+2', Body: 'hi', From: '+1' })); // different param order
  expect(a).toBe(b); // params are sorted before hashing
  expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/); // base64
  const other = await twilioSignature('other-token', url, new URLSearchParams({ From: '+1', To: '+2', Body: 'hi' }));
  expect(other).not.toBe(a); // keyed by the auth token
});
