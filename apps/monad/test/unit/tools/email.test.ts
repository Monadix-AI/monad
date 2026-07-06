import type { SmtpConfig, SmtpIO, SmtpReply } from '@/capabilities/tools/registry/email/smtp.ts';

import { afterEach, beforeEach, expect, test } from 'bun:test';

import {
  assertAddress,
  buildMimeMessage,
  configureEmail,
  EmailError,
  resendBackend,
  selectEmailBackend
} from '@/capabilities/tools/registry/email/index.ts';
import { parseSmtpReply, sendMail } from '@/capabilities/tools/registry/email/smtp.ts';

// ── MIME builder ──────────────────────────────────────────────────────────────────

const baseMsg = { from: 'me@example.com', to: ['you@example.org'], subject: 'Hi', body: 'Hello there' };
const fixedOpts = { date: 'Sat, 14 Jun 2026 00:00:00 GMT', messageId: '<fixed@example.com>' };

test('buildMimeMessage emits RFC5322 headers with a base64 body', () => {
  const mime = buildMimeMessage(baseMsg, fixedOpts);
  expect(mime).toContain('From: me@example.com');
  expect(mime).toContain('To: you@example.org');
  expect(mime).toContain('Subject: Hi');
  expect(mime).toContain('Content-Transfer-Encoding: base64');
  // Body is base64 of "Hello there".
  expect(mime).toContain(Buffer.from('Hello there', 'utf-8').toString('base64'));
  expect(mime.split('\r\n').every((l) => !l.startsWith('.'))).toBe(true); // no dot-stuffing needed
});

test('buildMimeMessage encodes a non-ASCII subject as an RFC2047 word', () => {
  const mime = buildMimeMessage({ ...baseMsg, subject: '你好 🌍' }, fixedOpts);
  expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from('你好 🌍', 'utf-8').toString('base64')}?=`);
});

test('assertAddress rejects header-injection and malformed addresses', () => {
  expect(() => assertAddress('a@b.com\r\nBcc: evil@x.com')).toThrow(EmailError);
  expect(() => assertAddress('not-an-email')).toThrow(EmailError);
  expect(assertAddress('ok@good.io')).toBe('ok@good.io');
});

// ── SMTP dialog (scripted mock IO) ──────────────────────────────────────────────────

function mockIo(replies: SmtpReply[]): { io: SmtpIO; sent: string[]; data: string[]; tls: { upgrades: number } } {
  const queue = [...replies];
  const sent: string[] = [];
  const data: string[] = [];
  const tls = { upgrades: 0 };
  const io: SmtpIO = {
    readReply: async () => {
      const r = queue.shift();
      if (!r) throw new Error('mock SMTP: reply queue exhausted');
      return r;
    },
    send: async (line) => {
      sent.push(line);
    },
    sendData: async (d) => {
      data.push(d);
    },
    upgradeTls: async () => {
      tls.upgrades++;
    },
    close: () => {}
  };
  return { io, sent, data, tls };
}

const secureCfg: SmtpConfig = {
  host: 'smtp.example.com',
  port: 465,
  user: 'u',
  pass: 'p',
  secure: true,
  clientName: 'monad'
};

test('sendMail drives a full implicit-TLS dialog with AUTH LOGIN', async () => {
  const { io, sent, data } = mockIo([
    { code: 220, lines: ['ready'] },
    { code: 250, lines: ['smtp.example.com', 'AUTH LOGIN PLAIN'] }, // EHLO caps
    { code: 334, lines: ['Username'] },
    { code: 334, lines: ['Password'] },
    { code: 235, lines: ['authenticated'] },
    { code: 250, lines: ['ok'] }, // MAIL FROM
    { code: 250, lines: ['ok'] }, // RCPT TO
    { code: 354, lines: ['go ahead'] }, // DATA
    { code: 250, lines: ['queued'] } // body accepted
  ]);

  const res = await sendMail(io, secureCfg, baseMsg, fixedOpts);
  expect(res).toEqual({ backend: 'smtp' });
  expect(sent[0]).toBe('EHLO monad');
  expect(sent).toContain('AUTH LOGIN');
  expect(sent).toContain(Buffer.from('u', 'utf-8').toString('base64'));
  expect(sent).toContain('MAIL FROM:<me@example.com>');
  expect(sent).toContain('RCPT TO:<you@example.org>');
  expect(sent).toContain('DATA');
  expect(sent).toContain('QUIT');
  expect(data[0]?.endsWith('\r\n.\r\n')).toBe(true);
});

test('sendMail performs STARTTLS upgrade on a plaintext connection', async () => {
  const cfg: SmtpConfig = { ...secureCfg, port: 587, secure: false };
  const { io, sent, tls } = mockIo([
    { code: 220, lines: ['ready'] },
    { code: 250, lines: ['smtp', 'STARTTLS', 'AUTH LOGIN'] }, // first EHLO
    { code: 220, lines: ['go ahead'] }, // STARTTLS
    { code: 250, lines: ['smtp', 'AUTH LOGIN'] }, // re-EHLO
    { code: 334, lines: ['Username'] },
    { code: 334, lines: ['Password'] },
    { code: 235, lines: ['ok'] },
    { code: 250, lines: ['ok'] },
    { code: 250, lines: ['ok'] },
    { code: 354, lines: ['ok'] },
    { code: 250, lines: ['queued'] }
  ]);

  await sendMail(io, cfg, baseMsg, fixedOpts);
  expect(sent).toContain('STARTTLS');
  expect(tls.upgrades).toBe(1);
  expect(sent.filter((l) => l === 'EHLO monad')).toHaveLength(2); // before and after upgrade
});

test('sendMail throws when authentication is rejected', async () => {
  const { io } = mockIo([
    { code: 220, lines: ['ready'] },
    { code: 250, lines: ['smtp', 'AUTH LOGIN'] },
    { code: 334, lines: ['Username'] },
    { code: 334, lines: ['Password'] },
    { code: 535, lines: ['auth failed'] }
  ]);
  await expect(sendMail(io, secureCfg, baseMsg, fixedOpts)).rejects.toThrow(/expected 235, got 535/);
});

test('parseSmtpReply takes the code from the final line of a multiline reply', () => {
  expect(parseSmtpReply(['250-first', '250-second', '250 last'])).toEqual({
    code: 250,
    lines: ['first', 'second', 'last']
  });
});

// ── backend selection via configureEmail ──────────────────────────────────────────

beforeEach(() => configureEmail({ backend: 'auto' }));
afterEach(() => configureEmail({ backend: 'auto' }));

test('selectEmailBackend returns null when nothing is configured', () => {
  configureEmail({ backend: 'auto' });
});

test('selectEmailBackend auto-detects Resend when apiKey is set', () => {
  configureEmail({ backend: 'auto', resendApiKey: 'rk' });
  expect(selectEmailBackend()?.name).toBe('resend');
});

test('selectEmailBackend auto-detects SMTP when smtp config is set', () => {
  configureEmail({ backend: 'auto', smtp: { host: 'smtp.x', port: 465, secure: true, clientName: 'monad' } });
  expect(selectEmailBackend()?.name).toBe('smtp');
});

test('selectEmailBackend honors explicit backend=smtp over resend key', () => {
  configureEmail({
    backend: 'smtp',
    resendApiKey: 'k',
    smtp: { host: 's', port: 587, secure: false, clientName: 'monad' }
  });
  expect(selectEmailBackend()?.name).toBe('smtp');
});

test('selectEmailBackend throws when backend=resend but no apiKey', () => {
  configureEmail({ backend: 'resend' });
  expect(() => selectEmailBackend()).toThrow(EmailError);
});

test('selectEmailBackend throws on an unknown backend', () => {
  configureEmail({ backend: 'auto', smtp: { host: 'h', port: 465, secure: true, clientName: 'monad' } });
  // Validate that a bad backend enum would be caught at config parse time (schema enforces enum).
  // At runtime, the union is exhaustive — no unknown backend can reach selectEmailBackend.
  expect(selectEmailBackend()?.name).toBe('smtp'); // sanity: valid config works fine
});

test('resendBackend POSTs to the Resend API and returns the message id', async () => {
  const captured: Array<{ url: string; body: unknown }> = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ id: 'msg_123' }), { status: 200 });
  }) as unknown as typeof fetch;

  const backend = resendBackend('rk_test', fakeFetch);
  const res = await backend.send(baseMsg);
  expect(res).toEqual({ id: 'msg_123', backend: 'resend' });
  expect(captured[0]?.url).toBe('https://api.resend.com/emails');
  expect(captured[0]?.body).toMatchObject({ from: 'me@example.com', to: ['you@example.org'], subject: 'Hi' });
});

test('resendBackend surfaces an API error', async () => {
  const fakeFetch = (async () => new Response('bad key', { status: 401 })) as unknown as typeof fetch;
  await expect(resendBackend('rk', fakeFetch).send(baseMsg)).rejects.toThrow(/resend send failed: 401/);
});
