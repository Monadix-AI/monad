// IRC channel adapter — a raw TCP socket (Bun.connect), TLS by default. Dial-out, so no public URL.
// Pure platform I/O: it normalizes PRIVMSG → ChannelInbound and writes PRIVMSG back; it never
// touches sessions. The server password (if any) arrives via ctx.secrets.token.
//
// options: { host, port?=6697, tls?=true, nick?='monad', channels?: string[] }

import type { ChannelInbound } from '@monad/protocol';
import type { ChannelAdapter, ChannelCapabilities, ChannelContext, SentMessage } from '@monad/sdk-atom';

import { defineChannel } from '@monad/sdk-atom';

const MAX_BACKOFF_MS = 30_000;

const IRC_CAPABILITIES: ChannelCapabilities = {
  edit: false,
  typing: false,
  threads: false,
  maxMessageChars: 400, // IRC lines cap ~512 bytes incl. prefix/CRLF; 400 leaves headroom
  markdown: false,
  reactions: false,
  nativeCommands: false,
  outboundMirror: true
};

export interface IrcLine {
  prefix?: string;
  command: string;
  params: string[];
}

/** Parse one raw IRC line into { prefix, command, params } (params includes the trailing arg). */
export function parseIrcLine(line: string): IrcLine {
  let rest = line;
  let prefix: string | undefined;
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  const params: string[] = [];
  while (rest.length) {
    if (rest.startsWith(':')) {
      params.push(rest.slice(1));
      break;
    }
    const sp = rest.indexOf(' ');
    if (sp === -1) {
      params.push(rest);
      break;
    }
    params.push(rest.slice(0, sp));
    rest = rest.slice(sp + 1);
  }
  const [command = '', ...args] = params;
  return { prefix, command: command.toUpperCase(), params: args };
}

/** Convert a parsed PRIVMSG into a ChannelInbound, or null if it isn't a usable message. A channel
 *  target (#…/&…) maps to a group keyed by the channel; a direct target maps to a DM keyed by the
 *  sender (so replies go back to them). Exported for tests. */
export function ircPrivmsgToInbound(line: IrcLine, selfNick: string | undefined, seq: number): ChannelInbound | null {
  if (line.command !== 'PRIVMSG' || line.params.length < 2) return null;
  const target = line.params[0] as string;
  const text = line.params[1] as string;
  const senderNick = line.prefix ? (line.prefix.split('!')[0] as string) : '';
  const isChannel = target.startsWith('#') || target.startsWith('&');
  const isCommand = text.startsWith('/');
  const [head, ...args] = isCommand ? text.trim().split(/\s+/) : [];
  const command = head ? head.slice(1).toLowerCase() : undefined;
  const addressed =
    selfNick !== undefined &&
    new RegExp(`(^|\\W)${selfNick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\W|$)`, 'i').test(text);
  return {
    chatId: isChannel ? target : senderNick,
    userId: senderNick,
    text,
    kind: isCommand ? 'command' : 'text',
    command,
    commandArgs: args,
    nativeMessageId: `irc-${seq}`,
    senderDisplay: senderNick,
    chatType: isChannel ? 'group' : 'dm',
    mentionedSelf: addressed,
    isSelf: selfNick !== undefined && senderNick.toLowerCase() === selfNick.toLowerCase(),
    media: [],
    at: new Date().toISOString()
  };
}

/** Collapse CR/LF and strip control chars from outbound text — prevents IRC command injection from
 *  hostile (agent-generated) content being written into a PRIVMSG line. Exported for tests. */
export function sanitizeIrcText(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
  return s.replace(/[\r\n\0\x01-\x1f]/g, ' ');
}

/** A target must be a single token (no whitespace / NUL / `,` / leading `:`). Exported for tests. */
export function sanitizeIrcTarget(target: string): string {
  if (!/^[^\s\0,:][^\s\0,]*$/.test(target)) throw new Error(`irc: invalid target "${target}"`);
  return target;
}

export function createIrcAdapter(ctx: ChannelContext): ChannelAdapter {
  const password = ctx.secrets.token;
  const host = String(ctx.config.options.host ?? '');
  const port = Number(ctx.config.options.port) || 6697;
  const tls = ctx.config.options.tls !== false;
  const nick = (typeof ctx.config.options.nick === 'string' ? ctx.config.options.nick : 'monad') || 'monad';
  const channels = Array.isArray(ctx.config.options.channels) ? (ctx.config.options.channels as string[]) : [];

  let socket: Awaited<ReturnType<typeof Bun.connect>> | undefined;
  let buffer = '';
  let seq = 0;
  let backoff = 1000;

  function write(line: string): void {
    socket?.write(`${line}\r\n`);
  }

  function onLine(raw: string): void {
    const line = parseIrcLine(raw);
    if (line.command === 'PING') {
      write(`PONG :${line.params[0] ?? ''}`);
      return;
    }
    if (line.command === '001') {
      // Welcome — now safe to join.
      for (const ch of channels) write(`JOIN ${ch}`);
      backoff = 1000;
      return;
    }
    const inbound = ircPrivmsgToInbound(line, nick, ++seq);
    if (inbound) ctx.onMessage(inbound);
  }

  async function open(): Promise<void> {
    if (ctx.signal.aborted) return;
    try {
      socket = await Bun.connect({
        hostname: host,
        port,
        tls,
        socket: {
          open() {
            if (password) write(`PASS ${password}`);
            write(`NICK ${nick}`);
            write(`USER ${nick} 0 * :monad`);
          },
          data(_s, data) {
            buffer += data.toString();
            for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
              const raw = buffer.slice(0, nl).replace(/\r$/, '');
              buffer = buffer.slice(nl + 1);
              if (raw) onLine(raw);
            }
          },
          close() {
            if (ctx.signal.aborted) return;
            ctx.log('info', `irc closed — reconnecting in ${backoff}ms`);
            setTimeout(() => void open(), backoff);
            backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
          },
          error(_s, err) {
            ctx.log('warn', `irc socket error: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      });
    } catch (err) {
      if (ctx.signal.aborted) return;
      ctx.log('warn', `irc connect error: ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(() => void open(), backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }

  return {
    type: 'irc',
    capabilities: IRC_CAPABILITIES,

    async connect() {
      if (typeof Bun.connect !== 'function')
        throw new Error('irc: Bun.connect is not available on this platform (Windows is not yet supported)');
      if (!host) throw new Error('irc: options.host is required');
      await open();
    },

    async disconnect() {
      try {
        write('QUIT :bye');
        socket?.end();
      } catch {
        /* best effort */
      }
    },

    async send(chatId: string, content: string): Promise<SentMessage> {
      // Agent output is hostile input: strip CR/LF + control chars so it can't smuggle a raw IRC
      // command (e.g. "\r\nPRIVMSG …") into the wire, and reject a malformed target.
      const target = sanitizeIrcTarget(chatId);
      for (const part of content.split('\n')) write(`PRIVMSG ${target} :${sanitizeIrcText(part)}`);
      return { ref: `irc-out-${++seq}`, chatId };
    }
  };
}

/** First-party IRC channel, authored with the SDK's defineChannel. */
export const ircChannelAtom = defineChannel({
  type: 'irc',
  name: 'IRC',
  capabilities: IRC_CAPABILITIES,
  envVars: [],
  create: createIrcAdapter
});
