// Discord channel adapter — Gateway WebSocket for inbound, REST for outbound. The Gateway needs no
// public URL (it dials out), so it works behind NAT like the Telegram long-poll. Pure platform I/O:
// it normalizes inbound and exposes send/edit/typing/react; it never touches sessions. The bot token
// arrives via ctx.secrets.token. MESSAGE_CONTENT is a privileged intent — enable it in the Discord
// developer portal for the bot, or inbound text arrives empty.

import type { ChannelInbound } from '@monad/protocol';
import type { ChannelAdapter, ChannelCapabilities, ChannelContext, SendOptions, SentMessage } from '@monad/sdk-atom';
import type { RESTPatchAPIChannelMessageJSONBody, RESTPostAPIChannelMessageJSONBody } from 'discord-api-types/rest/v10';

import { defineChannel } from '@monad/sdk-atom';
import { z } from 'zod';

const API = 'https://discord.com/api/v10';
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
const MAX_BACKOFF_MS = 30_000;

// GUILD_MESSAGES (1<<9) | DIRECT_MESSAGES (1<<12) | MESSAGE_CONTENT (1<<15).
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15);

const DISCORD_CAPABILITIES: ChannelCapabilities = {
  edit: true,
  typing: true,
  threads: false,
  maxMessageChars: 2000,
  markdown: true,
  reactions: true,
  nativeCommands: false,
  outboundMirror: true
};

const discordUserSchema = z.object({
  id: z.string(),
  username: z.string().optional(),
  global_name: z.string().optional(),
  bot: z.boolean().optional()
});
const discordMessageSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  guild_id: z.string().optional(),
  author: discordUserSchema.optional(),
  content: z.string().optional(),
  mentions: z.array(z.object({ id: z.string() })).optional(),
  referenced_message: z
    .object({ id: z.string().optional(), author: z.object({ id: z.string() }).optional() })
    .nullable()
    .optional()
});
const discordGatewayPayloadSchema = z.object({
  op: z.number(),
  d: z.unknown().optional(),
  s: z.number().nullable().optional(),
  t: z.string().optional()
});
const discordHelloSchema = z.object({ heartbeat_interval: z.number() });
const discordReadySchema = z.object({ user: z.object({ id: z.string() }) });
const discordRestMessageSchema = z.object({ id: z.string() });

type DiscordMessage = z.infer<typeof discordMessageSchema>;

/**
 * Pure normalization of a Discord MESSAGE_CREATE payload → ChannelInbound. Exported for tests.
 *  - chatType: a `guild_id` ⇒ group, otherwise a DM.
 *  - command: a leading `/` (strip it, lowercase). Discord's native slash commands are a separate
 *    interactions API; this is the text-prefix convention shared with other channels.
 *  - mentionedSelf: the bot id appears in `mentions`, or the message replies to the bot.
 */
export function normalizeDiscordMessage(m: DiscordMessage, selfId?: string): ChannelInbound {
  const text = m.content ?? '';
  const isCommand = text.startsWith('/');
  const [head, ...args] = isCommand ? text.trim().split(/\s+/) : [];
  const command = head ? head.slice(1).toLowerCase() : undefined;
  const mentionedSelf =
    selfId !== undefined &&
    ((m.mentions ?? []).some((u) => u.id === selfId) || m.referenced_message?.author?.id === selfId);
  return {
    chatId: m.channel_id,
    userId: m.author?.id ?? m.channel_id,
    text,
    kind: isCommand ? 'command' : text ? 'text' : 'media',
    command,
    commandArgs: args,
    nativeMessageId: m.id,
    replyTo: m.referenced_message?.id,
    senderDisplay: m.author?.global_name ?? m.author?.username,
    chatType: m.guild_id ? 'group' : 'dm',
    mentionedSelf,
    isSelf: selfId !== undefined && m.author?.id === selfId,
    media: [],
    at: new Date().toISOString()
  };
}

export function createDiscordAdapter(ctx: ChannelContext): ChannelAdapter {
  const token = ctx.secrets.token;
  let selfId: string | undefined;

  let ws: WebSocket | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let seq: number | null = null;
  let acked = true;
  let backoff = 1000;

  async function rest<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctx.signal
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`discord ${method} ${path} failed: ${res.status} ${detail}`.trim());
    }
    return schema.parse(await res.json());
  }

  async function restNoContent(method: string, path: string): Promise<void> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
      signal: ctx.signal
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`discord ${method} ${path} failed: ${res.status} ${detail}`.trim());
    }
  }

  function stopHeartbeat(): void {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  }

  function sendOp(op: number, d: unknown): void {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op, d }));
  }

  function identify(): void {
    sendOp(2, {
      token,
      intents: INTENTS,
      properties: { os: 'linux', browser: 'monad', device: 'monad' }
    });
  }

  function startHeartbeat(intervalMs: number): void {
    stopHeartbeat();
    acked = true;
    heartbeat = setInterval(() => {
      // A missed ACK means a zombied connection — drop it so onclose triggers a reconnect.
      if (!acked) {
        ws?.close(4000);
        return;
      }
      acked = false;
      sendOp(1, seq);
    }, intervalMs);
  }

  function handle(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = discordGatewayPayloadSchema.safeParse(json);
    if (!parsed.success) return;
    const payload = parsed.data;
    if (typeof payload.s === 'number') seq = payload.s;
    switch (payload.op) {
      case 10: {
        // Hello: begin heartbeating, then identify.
        const hello = discordHelloSchema.safeParse(payload.d);
        if (!hello.success) return;
        const interval = hello.data.heartbeat_interval;
        startHeartbeat(interval);
        identify();
        break;
      }
      case 11: // Heartbeat ACK
        acked = true;
        break;
      case 0: {
        // Dispatch.
        if (payload.t === 'READY') {
          const ready = discordReadySchema.safeParse(payload.d);
          if (!ready.success) return;
          selfId = ready.data.user.id;
          backoff = 1000; // a clean session resets the reconnect backoff
        } else if (payload.t === 'MESSAGE_CREATE') {
          const message = discordMessageSchema.safeParse(payload.d);
          if (!message.success) return;
          ctx.onMessage(normalizeDiscordMessage(message.data, selfId));
        }
        break;
      }
      case 7: // Server asked us to reconnect
      case 9: // Invalid session
        ws?.close(4000);
        break;
      default:
        break;
    }
  }

  function openGateway(): void {
    if (ctx.signal.aborted) return;
    seq = null;
    ws = new WebSocket(GATEWAY);
    ws.onmessage = (ev: MessageEvent) => handle(typeof ev.data === 'string' ? ev.data : '');
    ws.onerror = () => ctx.log('warn', 'discord gateway socket error');
    ws.onclose = () => {
      stopHeartbeat();
      if (ctx.signal.aborted) return;
      ctx.log('info', `discord gateway closed — reconnecting in ${backoff}ms`);
      setTimeout(openGateway, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    };
  }

  return {
    type: 'discord',
    capabilities: DISCORD_CAPABILITIES,

    async connect() {
      // Verify the token up front so connect() rejects on a bad credential.
      const me = await rest('GET', '/users/@me', discordRestMessageSchema);
      selfId = me.id;
      openGateway();
    },

    async disconnect() {
      stopHeartbeat();
      ws?.close(1000);
    },

    async send(chatId: string, content: string, opts?: SendOptions): Promise<SentMessage> {
      const msg = await rest('POST', `/channels/${chatId}/messages`, discordRestMessageSchema, {
        content,
        message_reference: opts?.replyTo ? { message_id: opts.replyTo, fail_if_not_exists: false } : undefined
      } satisfies RESTPostAPIChannelMessageJSONBody);
      return { ref: msg.id, chatId };
    },

    async editMessage(msg: SentMessage, content: string) {
      await rest('PATCH', `/channels/${msg.chatId}/messages/${msg.ref}`, discordRestMessageSchema, {
        content
      } satisfies RESTPatchAPIChannelMessageJSONBody);
    },

    async startTyping(chatId: string) {
      await restNoContent('POST', `/channels/${chatId}/typing`);
    },

    async react(target, emoji) {
      // Unicode emoji must be URL-encoded; custom emoji ("name:id") are passed through.
      await restNoContent(
        'PUT',
        `/channels/${target.chatId}/messages/${target.messageId}/reactions/${encodeURIComponent(emoji)}/@me`
      );
    }
  };
}

/** First-party Discord channel, authored with the SDK's defineChannel. */
export const discordChannelAtom = defineChannel({
  type: 'discord',
  name: 'Discord',
  capabilities: DISCORD_CAPABILITIES,
  envVars: [
    {
      name: 'DISCORD_BOT_TOKEN',
      description: 'Bot token from the Discord developer portal',
      required: true,
      secret: true
    }
  ],
  create: createDiscordAdapter
});
