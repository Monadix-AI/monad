// Email channel adapter — minimal IMAP poll (over TLS) for inbound, SMTP (implicit TLS) for outbound,
// both hand-rolled over Bun.connect to stay dependency-free. Deliberately scoped: polls UNSEEN every
// interval (no IDLE), extracts the first text/plain part (no attachments), threads replies by
// In-Reply-To. For richer needs swap in imapflow/nodemailer in a third-party atom pack. The pure
// parsers below are unit-tested; the socket orchestration is best-effort. Pure platform I/O.
//
// secrets: token = password (IMAP + SMTP share it unless extra.smtpPassword set).
// options: { user, imapHost, imapPort?=993, smtpHost, smtpPort?=465, from?, pollSec?=30 }

import type { ChannelInbound } from '@monad/protocol';
import type { ChannelAdapter, ChannelCapabilities, ChannelContext, SentMessage } from '@monad/sdk-atom';

import { defineChannel } from '@monad/sdk-atom';

const EMAIL_CAPABILITIES: ChannelCapabilities = {
  edit: false,
  typing: false,
  threads: false,
  maxMessageChars: 50_000,
  markdown: false,
  reactions: false,
  nativeCommands: false,
  outboundMirror: true
};

/** Parse an RFC822 header block into a lowercased-key map, unfolding continuation lines. Exported. */
export function parseEmailHeaders(headerBlock: string): Record<string, string> {
  const out: Record<string, string> = {};
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' '); // fold continuations onto their header
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

/** Decode a body per its Content-Transfer-Encoding (base64 / quoted-printable / identity). Exported. */
export function decodeTransferEncoding(body: string, encoding: string): string {
  const enc = encoding.toLowerCase();
  if (enc === 'base64') {
    try {
      return new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\s+/g, '')), (c) => c.charCodeAt(0)));
    } catch {
      return body;
    }
  }
  if (enc === 'quoted-printable') {
    return body
      .replace(/=\r?\n/g, '') // soft line breaks
      .replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return body;
}

/** Extract a plain-text body from a full RFC822 message: prefer the first text/plain MIME part, else
 *  the decoded top-level body. Exported for tests. */
export function extractTextBody(rfc822: string): string {
  const sep = rfc822.search(/\r?\n\r?\n/);
  if (sep === -1) return rfc822.trim();
  const headers = parseEmailHeaders(rfc822.slice(0, sep));
  const body = rfc822.slice(sep).replace(/^\r?\n\r?\n/, '');
  const ctype = headers['content-type'] ?? 'text/plain';
  const boundary = ctype.match(/boundary="?([^";]+)"?/i)?.[1];
  if (boundary) {
    for (const part of body.split(`--${boundary}`)) {
      const pSep = part.search(/\r?\n\r?\n/);
      if (pSep === -1) continue;
      const ph = parseEmailHeaders(part.slice(0, pSep));
      if ((ph['content-type'] ?? 'text/plain').toLowerCase().startsWith('text/plain')) {
        return decodeTransferEncoding(
          part.slice(pSep).replace(/^\r?\n\r?\n/, ''),
          ph['content-transfer-encoding'] ?? ''
        ).trim();
      }
    }
    return '';
  }
  return decodeTransferEncoding(body, headers['content-transfer-encoding'] ?? '').trim();
}

/** Bare email address out of a `Name <a@b>` header value. Exported for tests. */
export function parseAddress(headerValue: string): string {
  return (headerValue.match(/<([^>]+)>/)?.[1] ?? headerValue).trim();
}

/** Build a ChannelInbound from a fetched RFC822 message. The sender address is both user and (1:1)
 *  chat. Exported for tests. */
export function emailToInbound(rfc822: string): ChannelInbound | null {
  const sep = rfc822.search(/\r?\n\r?\n/);
  const headers = parseEmailHeaders(sep === -1 ? rfc822 : rfc822.slice(0, sep));
  const from = parseAddress(headers.from ?? '');
  if (!from) return null;
  const text = extractTextBody(rfc822);
  const isCommand = text.startsWith('/');
  const [head, ...args] = isCommand ? text.trim().split(/\s+/) : [];
  return {
    chatId: from,
    userId: from,
    text,
    kind: isCommand ? 'command' : 'text',
    command: head ? head.slice(1).toLowerCase() : undefined,
    commandArgs: args,
    nativeMessageId: headers['message-id'] ?? `email-${Date.now()}`,
    senderDisplay: headers.from?.replace(/<[^>]+>/, '').trim() || undefined,
    chatType: 'dm',
    isSelf: false,
    media: [],
    at: new Date().toISOString()
  };
}

/** Strip CR/LF from an SMTP header value to prevent header injection. */
export function sanitizeSmtpHeader(v: string): string {
  return v.replace(/[\r\n]+/g, ' ');
}

export function createEmailAdapter(ctx: ChannelContext): ChannelAdapter {
  const opt = ctx.config.options;
  const user = String(opt.user ?? '');
  const password = ctx.secrets.token ?? '';
  const smtpPassword = ctx.secrets.smtpPassword ?? password;
  const imapHost = String(opt.imapHost ?? '');
  const imapPort = Number(opt.imapPort) || 993;
  const smtpHost = String(opt.smtpHost ?? '');
  const smtpPort = Number(opt.smtpPort) || 465;
  const from = String(opt.from ?? user);
  const pollSec = Number(opt.pollSec) || 30;

  let imap: Awaited<ReturnType<typeof Bun.connect>> | undefined;
  let buffer = '';
  let waiter: { tag: string; resolve: (chunk: string) => void } | undefined;
  let tagSeq = 0;
  // Subject + Message-ID per sender, so a reply can thread (In-Reply-To) and keep the subject.
  const threadCtx = new Map<string, { subject: string; messageId: string }>();

  function checkWaiter(): void {
    if (!waiter) return;
    // Tagged completion line: "<tag> OK|NO|BAD …".
    const re = new RegExp(`(^|\\n)${waiter.tag} (OK|NO|BAD)[^\\n]*\\n`);
    const m = buffer.match(re);
    if (m) {
      const end = (m.index ?? 0) + m[0].length;
      const chunk = buffer.slice(0, end);
      buffer = buffer.slice(end);
      const w = waiter;
      waiter = undefined;
      w.resolve(chunk);
    }
  }

  function send(line: string): Promise<string> {
    const tag = `a${++tagSeq}`;
    return new Promise((resolve) => {
      waiter = { tag, resolve };
      imap?.write(`${tag} ${line}\r\n`);
      checkWaiter();
    });
  }

  async function pollOnce(): Promise<void> {
    await send('SELECT INBOX');
    const search = await send('SEARCH UNSEEN');
    const ids = (search.match(/\* SEARCH([^\r\n]*)/)?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
    for (const id of ids) {
      if (ctx.signal.aborted) return;
      const fetched = await send(`FETCH ${id} (BODY.PEEK[])`);
      const lit = fetched.match(/\{(\d+)\}\r?\n/);
      if (lit) {
        const start = (lit.index ?? 0) + lit[0].length;
        const rfc822 = fetched.slice(start, start + Number(lit[1]));
        const inbound = emailToInbound(rfc822);
        if (inbound) {
          const h = parseEmailHeaders(rfc822.slice(0, rfc822.search(/\r?\n\r?\n/)));
          threadCtx.set(inbound.chatId, { subject: h.subject ?? '', messageId: h['message-id'] ?? '' });
          ctx.onMessage(inbound);
        }
      }
      await send(`STORE ${id} +FLAGS (\\Seen)`);
    }
  }

  async function pollLoop(): Promise<void> {
    while (!ctx.signal.aborted) {
      try {
        await pollOnce();
      } catch (err) {
        ctx.log('warn', `imap poll error: ${err instanceof Error ? err.message : String(err)}`);
      }
      await new Promise((r) => setTimeout(r, pollSec * 1000));
    }
  }

  async function smtpSend(to: string, subject: string, body: string, inReplyTo?: string): Promise<void> {
    const sock = await Bun.connect({ hostname: smtpHost, port: smtpPort, tls: true, socket: { data() {} } });
    const w = (s: string) => sock.write(s);
    // Fire-and-forget pipelined SMTP; servers accept it for a single small message. Best-effort.
    w(`EHLO ${smtpHost}\r\n`);
    w(`AUTH LOGIN\r\n${btoa(user)}\r\n${btoa(smtpPassword)}\r\n`);
    w(`MAIL FROM:<${from}>\r\n`);
    w(`RCPT TO:<${to}>\r\n`);
    w('DATA\r\n');
    const headers = [
      `From: ${sanitizeSmtpHeader(from)}`,
      `To: ${sanitizeSmtpHeader(to)}`,
      `Subject: ${sanitizeSmtpHeader(subject)}`,
      'Content-Type: text/plain; charset=utf-8'
    ];
    if (inReplyTo)
      headers.push(`In-Reply-To: ${sanitizeSmtpHeader(inReplyTo)}`, `References: ${sanitizeSmtpHeader(inReplyTo)}`);
    w(`${headers.join('\r\n')}\r\n\r\n${body.replace(/\r?\n\./g, '\n..')}\r\n.\r\n`);
    w('QUIT\r\n');
    await new Promise((r) => setTimeout(r, 500));
    sock.end();
  }

  return {
    type: 'email',
    capabilities: EMAIL_CAPABILITIES,

    async connect() {
      if (typeof Bun.connect !== 'function')
        throw new Error('email: Bun.connect is not available on this platform (Windows is not yet supported)');
      if (!user || !imapHost || !smtpHost) throw new Error('email: options.user, imapHost and smtpHost are required');
      imap = await Bun.connect({
        hostname: imapHost,
        port: imapPort,
        tls: true,
        socket: {
          data(_s, data) {
            buffer += data.toString('binary');
            checkWaiter();
          },
          close() {
            if (!ctx.signal.aborted) ctx.log('warn', 'imap connection closed');
          }
        }
      });
      // Wait for the server greeting, then log in and start polling.
      await new Promise((r) => setTimeout(r, 200));
      buffer = '';
      await send(`LOGIN ${user} ${password}`);
      void pollLoop();
    },

    async disconnect() {
      imap?.end();
      imap = undefined;
    },

    async send(chatId: string, content: string): Promise<SentMessage> {
      const tc = threadCtx.get(chatId);
      const subject = tc?.subject
        ? tc.subject.toLowerCase().startsWith('re:')
          ? tc.subject
          : `Re: ${tc.subject}`
        : 'Message from monad';
      await smtpSend(chatId, subject, content, tc?.messageId || undefined);
      return { ref: `email-${Date.now()}`, chatId };
    }
  };
}

export const emailChannelAtom = defineChannel({
  type: 'email',
  name: 'Email (IMAP/SMTP)',
  capabilities: EMAIL_CAPABILITIES,
  envVars: [{ name: 'EMAIL_PASSWORD', description: 'IMAP/SMTP password', required: true, secret: true }],
  create: createEmailAdapter
});
