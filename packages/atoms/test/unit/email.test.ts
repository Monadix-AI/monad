import { expect, test } from 'bun:test';

import {
  decodeTransferEncoding,
  emailToInbound,
  extractTextBody,
  parseAddress,
  parseEmailHeaders,
  sanitizeSmtpHeader
} from '../../src/channels/email.ts';

test('EM1: header parse unfolds continuations + lowercases keys', () => {
  const h = parseEmailHeaders('From: Al <a@b.com>\r\nSubject: hello\r\n world\r\nMessage-ID: <x@y>');
  expect(h.from).toBe('Al <a@b.com>');
  expect(h.subject).toBe('hello world'); // folded
  expect(h['message-id']).toBe('<x@y>');
});

test('EM2: parseAddress extracts bare address', () => {
  expect(parseAddress('Alice <alice@example.com>')).toBe('alice@example.com');
  expect(parseAddress('bob@example.com')).toBe('bob@example.com');
});

test('EM3: transfer-encoding decode (base64 + quoted-printable)', () => {
  expect(decodeTransferEncoding('aGVsbG8=', 'base64')).toBe('hello');
  expect(decodeTransferEncoding('a=3Db=\r\nc', 'quoted-printable')).toBe('a=bc');
  expect(decodeTransferEncoding('plain', '7bit')).toBe('plain');
});

test('EM4: extractTextBody — simple body and multipart picks text/plain', () => {
  expect(extractTextBody('Subject: x\r\n\r\nhello body')).toBe('hello body');
  const mp = [
    'Content-Type: multipart/alternative; boundary="B"',
    '',
    '--B',
    'Content-Type: text/html',
    '',
    '<p>nope</p>',
    '--B',
    'Content-Type: text/plain',
    '',
    'yes plain',
    '--B--'
  ].join('\r\n');
  expect(extractTextBody(mp)).toBe('yes plain');
});

test('EM5: emailToInbound — sender is chat + user (dm), command parse', () => {
  const ev = emailToInbound('From: Al <a@b.com>\r\nSubject: Hi\r\nMessage-ID: <m1>\r\n\r\n/new topic');
  expect(ev).toMatchObject({
    chatId: 'a@b.com',
    userId: 'a@b.com',
    chatType: 'dm',
    command: 'new',
    commandArgs: ['topic'],
    nativeMessageId: '<m1>'
  });
});

test('EM6: sanitizeSmtpHeader strips CR/LF to prevent header injection', () => {
  expect(sanitizeSmtpHeader('hello\r\nBCC: evil@x.com')).toBe('hello BCC: evil@x.com');
  expect(sanitizeSmtpHeader('clean subject')).toBe('clean subject');
  expect(sanitizeSmtpHeader('a\nb\rc')).toBe('a b c');
});
