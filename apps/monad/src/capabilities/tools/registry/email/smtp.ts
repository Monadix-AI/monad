// SMTP backend for email_send — a zero-dependency ESMTP client. The protocol dialog
// (sendMail) is pure and drives an abstract SmtpIO, so it unit-tests against a scripted mock
// with no live server; the Bun-socket adapter (bunSmtpConnect) is the only untestable seam.
//
// Two TLS modes: implicit TLS (port 465, the secure default) connects encrypted from the
// start; STARTTLS (port 587) connects plaintext then upgrades after the STARTTLS reply.

import type { EmailBackend, EmailMessage, EmailSendResult } from './index.ts';

import { buildMimeMessage, EmailError } from './index.ts';

export interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  /** Implicit TLS (465). When false, connect plaintext and STARTTLS-upgrade (587). */
  secure: boolean;
  /** EHLO name announced to the server. */
  clientName: string;
}

export interface SmtpReply {
  code: number;
  lines: string[];
}

/** The seam the dialog talks to — a line-oriented duplex with a TLS-upgrade hook. */
export interface SmtpIO {
  readReply(): Promise<SmtpReply>;
  send(line: string): Promise<void>;
  sendData(data: string): Promise<void>;
  upgradeTls(): Promise<void>;
  close(): void;
}

/** Parse one (possibly multiline) SMTP reply from a buffer of complete CRLF lines.
 * A continuation line is `NNN-text`; the final line is `NNN text`. */
export function parseSmtpReply(lines: string[]): SmtpReply {
  const code = Number.parseInt(lines[lines.length - 1]?.slice(0, 3) ?? '0', 10);
  return { code, lines: lines.map((l) => l.slice(4)) };
}

function expect(reply: SmtpReply, ...codes: number[]): SmtpReply {
  if (!codes.includes(reply.code)) {
    throw new EmailError(`SMTP error: expected ${codes.join('/')}, got ${reply.code} ${reply.lines.join(' ')}`);
  }
  return reply;
}

/** Drive the full ESMTP send dialog over `io`. Pure given the IO — no sockets here. */
export async function sendMail(
  io: SmtpIO,
  cfg: SmtpConfig,
  msg: Required<Pick<EmailMessage, 'from' | 'to' | 'subject' | 'body'>> & EmailMessage,
  opts: { date?: string; messageId?: string } = {}
): Promise<EmailSendResult> {
  expect(await io.readReply(), 220);

  const ehlo = async () => {
    await io.send(`EHLO ${cfg.clientName}`);
    return expect(await io.readReply(), 250);
  };
  let caps = await ehlo();

  if (!cfg.secure) {
    if (!caps.lines.some((l) => l.toUpperCase().startsWith('STARTTLS'))) {
      throw new EmailError('SMTP server does not advertise STARTTLS but secure connection was requested');
    }
    await io.send('STARTTLS');
    expect(await io.readReply(), 220);
    await io.upgradeTls();
    caps = await ehlo(); // re-handshake over the now-encrypted channel
  }

  if (cfg.user && cfg.pass) {
    const supportsLogin = caps.lines.some((l) => /AUTH.*\bLOGIN\b/i.test(l));
    if (supportsLogin) {
      await io.send('AUTH LOGIN');
      expect(await io.readReply(), 334);
      await io.send(Buffer.from(cfg.user, 'utf-8').toString('base64'));
      expect(await io.readReply(), 334);
      await io.send(Buffer.from(cfg.pass, 'utf-8').toString('base64'));
      expect(await io.readReply(), 235);
    } else {
      const plain = Buffer.from(`\0${cfg.user}\0${cfg.pass}`, 'utf-8').toString('base64');
      await io.send(`AUTH PLAIN ${plain}`);
      expect(await io.readReply(), 235);
    }
  }

  await io.send(`MAIL FROM:<${msg.from}>`);
  expect(await io.readReply(), 250);
  for (const rcpt of [...msg.to, ...(msg.cc ?? []), ...(msg.bcc ?? [])]) {
    await io.send(`RCPT TO:<${rcpt}>`);
    expect(await io.readReply(), 250, 251);
  }

  await io.send('DATA');
  expect(await io.readReply(), 354);
  await io.sendData(`${buildMimeMessage(msg, opts)}\r\n.\r\n`);
  expect(await io.readReply(), 250);

  await io.send('QUIT');
  io.close();
  return { backend: 'smtp' };
}

/** Bun-socket SmtpIO adapter: bridges Bun.connect's event API into a readReply queue and
 * supports a mid-stream STARTTLS upgrade. This is the one piece that needs a live server. */
async function bunSmtpConnect(cfg: SmtpConfig): Promise<SmtpIO> {
  let buffer = '';
  const replies: SmtpReply[] = [];
  let waiter: ((r: SmtpReply) => void) | null = null;
  let failure: Error | null = null;

  const onData = (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    const pending: string[] = [];
    // Accumulate complete lines; emit a reply when a final (`NNN text`) line lands.
    while (nl !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      pending.push(line);
      if (/^\d{3} /.test(line)) {
        const reply = parseSmtpReply(pending.splice(0, pending.length));
        if (waiter) {
          waiter(reply);
          waiter = null;
        } else replies.push(reply);
      }
      nl = buffer.indexOf('\n');
    }
    // Leftover continuation lines with no terminator yet — push them back for the next chunk.
    if (pending.length) buffer = `${pending.join('\n')}\n${buffer}`;
  };

  type Sock = Awaited<ReturnType<typeof Bun.connect>>;
  let socket: Sock;
  const handlers = {
    data: (_s: Sock, data: Buffer) => onData(data.toString('utf-8')),
    error: (_s: Sock, err: Error) => {
      failure = err;
      waiter?.({ code: 0, lines: [String(err)] });
      waiter = null;
    },
    close: () => {
      if (waiter && !failure) {
        failure = new EmailError('SMTP connection closed unexpectedly');
        waiter({ code: 0, lines: ['connection closed'] });
        waiter = null;
      }
    }
  };

  socket = await Bun.connect({
    hostname: cfg.host,
    port: cfg.port,
    tls: cfg.secure,
    socket: handlers
  });

  const io: SmtpIO = {
    readReply: () =>
      new Promise<SmtpReply>((resolve, reject) => {
        if (failure) return reject(failure);
        const next = replies.shift();
        if (next) return resolve(next);
        waiter = resolve;
      }),
    send: async (line) => {
      socket.write(`${line}\r\n`);
    },
    sendData: async (data) => {
      socket.write(data);
    },
    upgradeTls: async () => {
      const [, tls] = socket.upgradeTLS({
        tls: { serverName: cfg.host },
        socket: handlers
      });
      socket = tls;
    },
    close: () => socket.end()
  };
  return io;
}

export function smtpBackend(cfg: SmtpConfig, connect = bunSmtpConnect): EmailBackend {
  return {
    name: 'smtp',
    async send(msg) {
      const io = await connect(cfg);
      try {
        return await sendMail(io, cfg, msg);
      } finally {
        io.close();
      }
    }
  };
}
