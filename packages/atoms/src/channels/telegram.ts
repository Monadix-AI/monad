// Telegram channel adapter — long-poll (getUpdates). Needs no public URL/webhook, so it
// works behind NAT. Pure platform I/O: it normalizes inbound and exposes send/edit/typing;
// it never touches sessions (the core owns that). The bot token arrives via ctx.secrets.token.

import type { Opts } from '@grammyjs/types';
import type { ChannelInbound } from '@monad/protocol';
import type { ChannelAdapter, ChannelCapabilities, ChannelContext, SendOptions, SentMessage } from '@monad/sdk-atom';

import { defineChannel } from '@monad/sdk-atom';

const POLL_TIMEOUT_SEC = 30;
const TELEGRAM_CAPABILITIES: ChannelCapabilities = {
  edit: true,
  typing: true,
  threads: false,
  maxMessageChars: 4096,
  markdown: false,
  reactions: true,
  nativeCommands: true,
  outboundMirror: true
};
const MAX_BACKOFF_MS = 30_000;

interface TgMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string; is_bot?: boolean };
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  reply_to_message?: { message_id: number; from?: { id: number } };
  message_thread_id?: number;
  entities?: Array<{ type: string; offset: number; length: number }>;
}

/**
 * Pure normalization of a Telegram message → ChannelInbound. Exported for conformance tests.
 *  - text precedence: `text` XOR `caption` (never concatenated).
 *  - command name: strip leading `/`, strip any `@suffix`, LOWERCASE (so `/NEW@Bot` → `new`).
 *  - args: tokens after the command word.
 *  - isSelf: sender id equals the bot's own id (echo guard).
 */
export function normalizeTelegramMessage(m: TgMessage, selfId?: string, selfUsername?: string): ChannelInbound {
  const text = m.text ?? m.caption ?? '';
  const isCommand = typeof m.text === 'string' && m.text.startsWith('/');
  const [head, ...args] = isCommand ? text.trim().split(/\s+/) : [];
  const command = head ? (head.slice(1).split('@')[0] as string).toLowerCase() : undefined;
  const chatType = m.chat.type === 'private' ? 'dm' : m.chat.type === 'channel' ? 'channel' : 'group';
  // Addressed when the message replies to the bot, or @mentions its username.
  const repliedToSelf =
    selfId !== undefined && m.reply_to_message?.from?.id != null && String(m.reply_to_message.from.id) === selfId;
  const mentionsSelf =
    selfUsername !== undefined &&
    (m.entities ?? []).some(
      (e) =>
        e.type === 'mention' &&
        text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${selfUsername.toLowerCase()}`
    );
  return {
    chatId: String(m.chat.id),
    userId: String(m.from?.id ?? m.chat.id),
    threadId: m.message_thread_id != null ? String(m.message_thread_id) : undefined,
    text,
    kind: isCommand ? 'command' : m.text || m.caption ? 'text' : 'media',
    command,
    commandArgs: args,
    nativeMessageId: String(m.message_id),
    replyTo: m.reply_to_message ? String(m.reply_to_message.message_id) : undefined,
    senderDisplay: m.from?.username ?? m.from?.first_name,
    chatType,
    mentionedSelf: repliedToSelf || mentionsSelf,
    isSelf: selfId !== undefined && String(m.from?.id) === selfId,
    media: [],
    at: new Date().toISOString()
  };
}

export function createTelegramAdapter(ctx: ChannelContext): ChannelAdapter {
  const token = ctx.secrets.token;
  const optTimeout = Number(ctx.config.options.pollTimeoutSec) || POLL_TIMEOUT_SEC;
  // Override for a self-hosted Telegram Bot API server (or a test double).
  const baseUrl = (
    typeof ctx.config.options.apiBaseUrl === 'string' ? ctx.config.options.apiBaseUrl : 'https://api.telegram.org'
  ).replace(/\/+$/, '');
  let selfId: string | undefined;
  let selfUsername: string | undefined;
  let offset = 0;

  const api = (method: string): string => `${baseUrl}/bot${token}/${method}`;

  async function call<T = { result: unknown }>(method: string, body?: unknown): Promise<T> {
    const res = await fetch(api(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctx.signal
    });
    const json = (await res.json()) as { ok: boolean; description?: string } & T;
    if (!json.ok) throw new Error(`telegram ${method} failed: ${json.description ?? res.status}`);
    return json;
  }

  const normalize = (m: TgMessage): ChannelInbound => normalizeTelegramMessage(m, selfId, selfUsername);

  async function poll(): Promise<void> {
    let backoff = 1000;
    while (!ctx.signal.aborted) {
      try {
        const res = await call<{ result: Array<{ update_id: number; message?: TgMessage }> }>('getUpdates', {
          offset,
          timeout: optTimeout,
          allowed_updates: ['message']
        });
        backoff = 1000;
        for (const u of res.result) {
          offset = u.update_id + 1;
          if (u.message) ctx.onMessage(normalize(u.message));
        }
      } catch (err) {
        if (ctx.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        // Conflict means another instance is polling (common during dev hot-reload).
        // The other process will exit shortly; retry with a short fixed delay instead of
        // escalating backoff, and log at info so it doesn't look like a persistent error.
        if (msg.includes('Conflict')) {
          ctx.log('info', `telegram poll: waiting for previous instance to exit (${msg})`);
          await new Promise((r) => setTimeout(r, 3000));
        } else {
          ctx.log('warn', `telegram poll error: ${msg}`);
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        }
      }
    }
  }

  return {
    type: 'telegram',
    capabilities: TELEGRAM_CAPABILITIES,

    async connect() {
      const me = await call<{ result: { id: number; username?: string } }>('getMe');
      selfId = String(me.result.id);
      selfUsername = me.result.username;
      // Detached receive loop — connect() returns once the token is verified.
      void poll();
    },

    async disconnect() {
      // The ctx.signal (aborted by ChannelService) stops the poll loop and in-flight fetches.
    },

    async send(chatId: string, content: string, opts?: SendOptions): Promise<SentMessage> {
      const res = await call<{ result: { message_id: number } }>('sendMessage', {
        chat_id: chatId,
        text: content,
        reply_parameters: opts?.replyTo ? { message_id: Number(opts.replyTo) } : undefined,
        message_thread_id: opts?.threadId ? Number(opts.threadId) : undefined
      } satisfies Opts<never>['sendMessage']);
      return { ref: String(res.result.message_id), chatId, threadId: opts?.threadId };
    },

    async editMessage(msg: SentMessage, content: string) {
      await call('editMessageText', {
        chat_id: msg.chatId,
        message_id: Number(msg.ref),
        text: content
      } satisfies Opts<never>['editMessageText']);
    },

    async startTyping(chatId: string) {
      await call('sendChatAction', {
        chat_id: chatId,
        action: 'typing'
      } satisfies Opts<never>['sendChatAction']);
    },

    async setCommands(commands) {
      await call('setMyCommands', { commands } satisfies Opts<never>['setMyCommands']);
    },

    async react(target, emoji) {
      await call('setMessageReaction', {
        chat_id: target.chatId,
        message_id: Number(target.messageId),
        reaction: [{ type: 'emoji', emoji }]
      });
    }
  };
}

/** First-party Telegram channel, authored with the SDK's defineChannel (the reference adapter). */
export const telegramChannelAtom = defineChannel({
  type: 'telegram',
  name: 'Telegram',
  capabilities: TELEGRAM_CAPABILITIES,
  envVars: [],
  create: createTelegramAdapter
});
