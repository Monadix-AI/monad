import type { MessageOrigin } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { SessionSteerMailbox } from '#/handlers/session/steer-mailbox.ts';

const steer = (text: string, origin?: MessageOrigin) => (origin ? { text, origin } : { text });

test('steer mailbox drains accepted messages in submission order', () => {
  const mailbox = new SessionSteerMailbox();

  expect(mailbox.enqueue(steer('first'))).toBe(true);
  expect(mailbox.enqueue(steer('second'))).toBe(true);
  expect(mailbox.take()).toEqual([steer('first'), steer('second')]);
  expect(mailbox.take()).toEqual([]);
});

test('a steer keeps the ingress provenance of the request that queued it', () => {
  const mailbox = new SessionSteerMailbox();
  const origin: MessageOrigin = { transport: 'channel', surface: 'im', client: 'slack', senderId: 'U1' };

  expect(mailbox.enqueue(steer('from slack', origin))).toBe(true);
  expect(mailbox.close()).toEqual([{ text: 'from slack', origin }]);
});

test('steer mailbox atomically accepts an ordered batch', () => {
  const mailbox = new SessionSteerMailbox();

  expect(mailbox.enqueueMany([steer('first'), steer('second'), steer('third')])).toBe(true);
  expect(mailbox.take()).toEqual([steer('first'), steer('second'), steer('third')]);

  mailbox.close();
  expect(mailbox.enqueueMany([steer('late first'), steer('late second')])).toBe(false);
  expect(mailbox.take()).toEqual([]);
});

test('closing a steer mailbox atomically drains it and rejects late submissions', () => {
  const mailbox = new SessionSteerMailbox();

  expect(mailbox.enqueue(steer('before close'))).toBe(true);
  expect(mailbox.close()).toEqual([steer('before close')]);
  expect(mailbox.enqueue(steer('after close'))).toBe(false);

  mailbox.reopen();
  expect(mailbox.enqueue(steer('after reopen'))).toBe(true);
  expect(mailbox.take()).toEqual([steer('after reopen')]);
});

test('steer mailbox accepts a batch atomically in its original order', () => {
  const mailbox = new SessionSteerMailbox();

  expect(mailbox.enqueueMany([steer('first'), steer('second')])).toBe(true);
  expect(mailbox.close()).toEqual([steer('first'), steer('second')]);
  expect(mailbox.enqueueMany([steer('late first'), steer('late second')])).toBe(false);
  expect(mailbox.take()).toEqual([]);
});
