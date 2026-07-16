import { expect, test } from 'bun:test';

import { SessionSteerMailbox } from '#/handlers/session/steer-mailbox.ts';

test('steer mailbox drains accepted messages in submission order', () => {
  const mailbox = new SessionSteerMailbox();

  expect(mailbox.enqueue('first')).toBe(true);
  expect(mailbox.enqueue('second')).toBe(true);
  expect(mailbox.take()).toEqual(['first', 'second']);
  expect(mailbox.take()).toEqual([]);
});

test('steer mailbox atomically accepts an ordered batch', () => {
  const mailbox = new SessionSteerMailbox();

  expect(mailbox.enqueueMany(['first', 'second', 'third'])).toBe(true);
  expect(mailbox.take()).toEqual(['first', 'second', 'third']);

  mailbox.close();
  expect(mailbox.enqueueMany(['late first', 'late second'])).toBe(false);
  expect(mailbox.take()).toEqual([]);
});

test('closing a steer mailbox atomically drains it and rejects late submissions', () => {
  const mailbox = new SessionSteerMailbox();

  expect(mailbox.enqueue('before close')).toBe(true);
  expect(mailbox.close()).toEqual(['before close']);
  expect(mailbox.enqueue('after close')).toBe(false);

  mailbox.reopen();
  expect(mailbox.enqueue('after reopen')).toBe(true);
  expect(mailbox.take()).toEqual(['after reopen']);
});

test('steer mailbox accepts a batch atomically in its original order', () => {
  const mailbox = new SessionSteerMailbox();

  expect(mailbox.enqueueMany(['first', 'second'])).toBe(true);
  expect(mailbox.close()).toEqual(['first', 'second']);
  expect(mailbox.enqueueMany(['late first', 'late second'])).toBe(false);
  expect(mailbox.take()).toEqual([]);
});
