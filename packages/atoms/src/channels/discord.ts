// Discord channel adapter — Gateway WebSocket for inbound, REST for outbound. The Gateway needs no
// public URL (it dials out), so it works behind NAT like the Telegram long-poll. Pure platform I/O:
// it normalizes inbound and exposes send/edit/typing/react; it never touches sessions. The bot token
// arrives via ctx.secrets.token. MESSAGE_CONTENT is a privileged intent — enable it in the Discord
// developer portal for the bot, or inbound text arrives empty.

import type { ChannelInbound } from '@monad/protocol';
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelContext,
  ChannelNativeCommand,
  SendOptions,
  SentMessage
} from '@monad/sdk-atom';
import type { APIApplicationCommandBasicOption } from 'discord-api-types/payloads/v10';
import type {
  RESTPatchAPIChannelMessageJSONBody,
  RESTPatchAPIWebhookWithTokenMessageJSONBody,
  RESTPostAPIChannelMessageJSONBody,
  RESTPostAPIWebhookWithTokenJSONBody,
  RESTPutAPIApplicationCommandsJSONBody
} from 'discord-api-types/rest/v10';

import { defineChannel } from '@monad/sdk-atom';
import { z } from 'zod';

import { channelIcons } from './icons.ts';
import { channelSetupGuides } from './setup-guides.ts';

const API = 'https://discord.com/api/v10';
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
const MAX_BACKOFF_MS = 30_000;
const INTERACTION_REPLY_PREFIX = 'interaction:';
const DISCORD_EPHEMERAL_FLAG = 1 << 6;
const NON_RECONNECTABLE_GATEWAY_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

// GUILD_MESSAGES (1<<9) | DIRECT_MESSAGES (1<<12) | MESSAGE_CONTENT (1<<15).
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15);

const DISCORD_CAPABILITIES: ChannelCapabilities = {
  edit: true,
  typing: true,
  threads: false,
  maxMessageChars: 2000,
  markdown: true,
  reactions: true,
  nativeCommands: true,
  outboundMirror: true,
  groupMentionPolicy: true
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
  t: z.string().nullable().optional()
});
const discordHelloSchema = z.object({ heartbeat_interval: z.number() });
const discordReadySchema = z.object({
  user: z.object({ id: z.string() }),
  application: z.object({ id: z.string() }).optional()
});
const discordRestMessageSchema = z.object({ id: z.string() });
const discordApplicationCommandsSchema = z.array(z.object({ id: z.string() }).passthrough());
const discordInteractionBasicOptionSchema = z.object({
  name: z.string(),
  type: z.number(),
  value: z.union([z.string(), z.number(), z.boolean()]).optional()
});
const discordInteractionOptionSchema = z.object({
  name: z.string(),
  type: z.number(),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(discordInteractionBasicOptionSchema).optional()
});
const discordCommandInteractionSchema = z.object({
  id: z.string(),
  application_id: z.string(),
  token: z.string(),
  type: z.literal(2),
  channel_id: z.string(),
  guild_id: z.string().optional(),
  member: z.object({ user: discordUserSchema }).optional(),
  user: discordUserSchema.optional(),
  data: z.object({
    type: z.literal(1),
    name: z.string(),
    options: z.array(discordInteractionOptionSchema).optional()
  })
});

type DiscordMessage = z.infer<typeof discordMessageSchema>;
type DiscordCommandInteraction = z.infer<typeof discordCommandInteractionSchema>;

/**
 * Pure normalization of a Discord MESSAGE_CREATE payload → ChannelInbound. Exported for tests.
 *  - chatType: a `guild_id` ⇒ group, otherwise a DM.
 *  - command: a leading `/` (strip it, lowercase). Discord's native slash commands are a separate
 *    interactions API; this is the text-prefix convention shared with other channels.
 *  - mentionedSelf: the bot id appears in `mentions`, or the message replies to the bot.
 */
export function normalizeDiscordMessage(m: DiscordMessage, selfId?: string): ChannelInbound {
  const text = stripLeadingSelfMention(m.content ?? '', selfId);
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

/** Discord serializes an explicit bot mention into the message body. Remove only a leading mention
 * of this bot so `@Bot /command` follows the shared channel command path and ordinary addressed
 * messages reach the model without the transport-specific mention token. */
function stripLeadingSelfMention(text: string, selfId?: string): string {
  if (!selfId) return text;
  for (const mention of [`<@${selfId}>`, `<@!${selfId}>`]) {
    if (text === mention) return '';
    if (text.startsWith(mention) && /^\s/.test(text.slice(mention.length))) {
      return text.slice(mention.length).trimStart();
    }
  }
  return text;
}

/** Convert the host's command discovery metadata into Discord CHAT_INPUT command registrations. */
export function discordApplicationCommands(commands: ChannelNativeCommand[]): RESTPutAPIApplicationCommandsJSONBody {
  return commands
    .filter(({ command }) => /^[a-z0-9_-]{1,32}$/.test(command))
    .slice(0, 100)
    .map((command) => ({
      name: command.command,
      description: discordDescription(command.description, command.command),
      type: 1,
      ...(command.subcommands?.length
        ? {
            options: command.subcommands.slice(0, 25).map((subcommand) => ({
              type: 1 as const,
              name: subcommand.id,
              description: discordDescription(subcommand.description, subcommand.name),
              ...(subcommand.args?.length ? { options: discordCommandOptions(subcommand.args) } : {})
            }))
          }
        : command.args?.length
          ? { options: discordCommandOptions(command.args) }
          : {})
    }));
}

/** Normalize a native Discord CHAT_INPUT interaction into the same command event text messages use. */
export function normalizeDiscordInteraction(interaction: DiscordCommandInteraction): ChannelInbound {
  const user = interaction.member?.user ?? interaction.user;
  const args = discordInteractionArgs(interaction.data.options ?? []);
  const text = `/${interaction.data.name}${args.length ? ` ${args.join(' ')}` : ''}`;
  const replyTarget = `${INTERACTION_REPLY_PREFIX}${interaction.id}`;
  return {
    chatId: interaction.channel_id,
    userId: user?.id ?? interaction.channel_id,
    text,
    kind: 'command',
    command: interaction.data.name.toLowerCase(),
    commandArgs: args,
    nativeMessageId: replyTarget,
    replyTo: replyTarget,
    senderDisplay: user?.global_name ?? user?.username,
    chatType: interaction.guild_id ? 'group' : 'dm',
    mentionedSelf: true,
    isSelf: false,
    media: [],
    at: new Date().toISOString()
  };
}

function discordDescription(description: string | undefined, fallback: string): string {
  return (description?.trim() || fallback).slice(0, 100);
}

function discordCommandOptions(args: ChannelNativeCommand['args']): APIApplicationCommandBasicOption[] {
  return [...(args ?? [])]
    .sort((a, b) => Number(Boolean(b.required)) - Number(Boolean(a.required)))
    .slice(0, 25)
    .map((arg) => {
      const type = arg.type === 'boolean' ? (5 as const) : arg.type === 'number' ? (10 as const) : (3 as const);
      return {
        type,
        name: arg.name
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '-')
          .slice(0, 32),
        description: discordDescription(arg.description ?? arg.placeholder, arg.name),
        required: arg.required ?? false,
        ...(type === 3 && arg.values?.length
          ? {
              choices: arg.values.slice(0, 25).map((value) => ({
                name: (value.name ?? value.id).slice(0, 100),
                value: value.id.slice(0, 100)
              }))
            }
          : {})
      } as APIApplicationCommandBasicOption;
    });
}

function discordInteractionArgs(options: DiscordCommandInteraction['data']['options']): string[] {
  const args: string[] = [];
  for (const option of options ?? []) {
    if ((option.type === 1 || option.type === 2) && option.options) {
      args.push(option.name);
      for (const nested of option.options) if (nested.value !== undefined) args.push(String(nested.value));
    } else if (option.value !== undefined) {
      args.push(String(option.value));
    }
  }
  return args;
}

export function createDiscordAdapter(ctx: ChannelContext): ChannelAdapter {
  const token = ctx.secrets.token;
  let selfId: string | undefined;
  let applicationId: string | undefined;
  const pendingInteractions = new Map<string, { applicationId: string; token: string; responded: boolean }>();

  let ws: WebSocket | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let seq: number | null = null;
  let acked = true;
  let backoff = 1000;
  let lastGatewayError: string | undefined;

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

  async function interactionRequest<T>(method: string, path: string, schema: z.ZodType<T>, body: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctx.signal
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`discord ${method} ${path} failed: ${res.status} ${detail}`.trim());
    }
    return schema.parse(await res.json());
  }

  async function deferInteraction(interaction: DiscordCommandInteraction): Promise<void> {
    const res = await fetch(`${API}/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 5, data: { flags: DISCORD_EPHEMERAL_FLAG } }),
      signal: ctx.signal
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`discord interaction defer failed: ${res.status} ${detail}`.trim());
    }
  }

  async function editInteractionReply(replyTarget: string, content: string): Promise<SentMessage | null> {
    const pending = pendingInteractions.get(replyTarget);
    if (!pending) return null;
    await interactionRequest(
      'PATCH',
      `/webhooks/${pending.applicationId}/${pending.token}/messages/@original`,
      discordRestMessageSchema,
      { content } satisfies RESTPatchAPIWebhookWithTokenMessageJSONBody
    );
    return { ref: replyTarget, chatId: '' };
  }

  async function sendInteractionReply(replyTarget: string, content: string): Promise<SentMessage | null> {
    const pending = pendingInteractions.get(replyTarget);
    if (!pending) return null;
    if (!pending.responded) {
      const message = await editInteractionReply(replyTarget, content);
      pending.responded = true;
      return message;
    }
    const message = await interactionRequest(
      'POST',
      `/webhooks/${pending.applicationId}/${pending.token}?wait=true`,
      discordRestMessageSchema,
      { content, flags: DISCORD_EPHEMERAL_FLAG } satisfies RESTPostAPIWebhookWithTokenJSONBody
    );
    return { ref: message.id, chatId: '' };
  }

  function rememberInteraction(interaction: DiscordCommandInteraction): string {
    const replyTarget = `${INTERACTION_REPLY_PREFIX}${interaction.id}`;
    if (pendingInteractions.size >= 1000) {
      const oldest = pendingInteractions.keys().next().value;
      if (oldest) pendingInteractions.delete(oldest);
    }
    pendingInteractions.set(replyTarget, {
      applicationId: interaction.application_id,
      token: interaction.token,
      responded: false
    });
    return replyTarget;
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
          applicationId = ready.data.application?.id ?? applicationId;
          backoff = 1000; // a clean session resets the reconnect backoff
          lastGatewayError = undefined;
          ctx.onStatus?.({ phase: 'connected' });
        } else if (payload.t === 'MESSAGE_CREATE') {
          const message = discordMessageSchema.safeParse(payload.d);
          if (!message.success) return;
          ctx.onMessage(normalizeDiscordMessage(message.data, selfId));
        } else if (payload.t === 'INTERACTION_CREATE') {
          const interaction = discordCommandInteractionSchema.safeParse(payload.d);
          if (!interaction.success) return;
          const inbound = normalizeDiscordInteraction(interaction.data);
          void deferInteraction(interaction.data)
            .then(() => {
              rememberInteraction(interaction.data);
              ctx.onMessage(inbound);
            })
            .catch((err: unknown) => {
              ctx.log(
                'warn',
                `discord interaction acknowledgement failed: ${err instanceof Error ? err.message : String(err)}`
              );
              const { replyTo: _replyTo, ...fallback } = inbound;
              ctx.onMessage(fallback);
            });
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
    ctx.onStatus?.({ phase: 'connecting', ...(lastGatewayError ? { error: lastGatewayError } : {}) });
    ws = new WebSocket(GATEWAY);
    ws.onmessage = (ev: MessageEvent) => handle(typeof ev.data === 'string' ? ev.data : '');
    ws.onerror = () => ctx.log('warn', 'discord gateway socket error');
    ws.onclose = (event: CloseEvent) => {
      stopHeartbeat();
      if (ctx.signal.aborted) return;
      const reason = event.reason.trim();
      lastGatewayError = `Discord Gateway closed (${event.code}${reason ? `: ${reason}` : ''})`;
      ctx.onStatus?.({ phase: 'error', error: lastGatewayError });
      if (NON_RECONNECTABLE_GATEWAY_CLOSE_CODES.has(event.code)) {
        ctx.log('error', `${lastGatewayError} — reconnect disabled until configuration changes`);
        return;
      }
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
      const [me, application] = await Promise.all([
        rest('GET', '/users/@me', discordRestMessageSchema),
        rest('GET', '/oauth2/applications/@me', discordRestMessageSchema)
      ]);
      selfId = me.id;
      applicationId = application.id;
      openGateway();
    },

    async disconnect() {
      stopHeartbeat();
      ws?.close(1000);
    },

    async send(chatId: string, content: string, opts?: SendOptions): Promise<SentMessage> {
      if (opts?.replyTo?.startsWith(INTERACTION_REPLY_PREFIX)) {
        const reply = await sendInteractionReply(opts.replyTo, content);
        if (!reply) throw new Error('discord interaction reply target is unavailable');
        return { ...reply, chatId };
      }
      const msg = await rest('POST', `/channels/${chatId}/messages`, discordRestMessageSchema, {
        content,
        message_reference:
          opts?.replyTo && !opts.replyTo.startsWith(INTERACTION_REPLY_PREFIX)
            ? { message_id: opts.replyTo, fail_if_not_exists: false }
            : undefined
      } satisfies RESTPostAPIChannelMessageJSONBody);
      return { ref: msg.id, chatId };
    },

    async editMessage(msg: SentMessage, content: string) {
      if (msg.ref.startsWith(INTERACTION_REPLY_PREFIX)) {
        if (!(await editInteractionReply(msg.ref, content))) {
          throw new Error('discord interaction reply target is unavailable');
        }
        return;
      }
      await rest('PATCH', `/channels/${msg.chatId}/messages/${msg.ref}`, discordRestMessageSchema, {
        content
      } satisfies RESTPatchAPIChannelMessageJSONBody);
    },

    async startTyping(chatId: string) {
      await restNoContent('POST', `/channels/${chatId}/typing`);
    },

    async setCommands(commands) {
      if (!applicationId) throw new Error('discord application id is unavailable before connect');
      await rest(
        'PUT',
        `/applications/${applicationId}/commands`,
        discordApplicationCommandsSchema,
        discordApplicationCommands(commands)
      );
    },

    async react(target, emoji) {
      if (target.messageId.startsWith(INTERACTION_REPLY_PREFIX)) {
        const pending = pendingInteractions.get(target.messageId);
        if (pending && !pending.responded) await sendInteractionReply(target.messageId, emoji);
        return;
      }
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
  icon: channelIcons.discord,
  setup: channelSetupGuides.discord,
  capabilities: DISCORD_CAPABILITIES,
  envVars: [
    {
      name: 'DISCORD_BOT_TOKEN',
      description: 'Bot token from the Discord developer portal',
      required: true,
      secret: true,
      credentialKey: 'token'
    }
  ],
  create: createDiscordAdapter
});
