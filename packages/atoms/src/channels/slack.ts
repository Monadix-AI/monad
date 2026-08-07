// Slack channel adapter — Socket Mode for inbound (no public URL needed), Web API for outbound.
// Socket Mode needs TWO credentials: a bot token (xoxb-…, ctx.secrets.token) for Web API calls and
// an app-level token (xapp-…, ctx.secrets.appToken) to open the socket. Store the app token in the
// channel credential's `extra.appToken`. Pure platform I/O: it never touches sessions.

import type { ChannelInbound } from '@monad/protocol';
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelContext,
  ChannelNativeCommand,
  SendOptions,
  SentMessage
} from '@monad/sdk-atom';

import { defineChannel } from '@monad/sdk-atom';
import { z } from 'zod';

import { channelIcons } from './icons.ts';
import { channelSetupGuides } from './setup-guides.ts';

const WEB_API = 'https://slack.com/api';
const MAX_BACKOFF_MS = 30_000;
const SLASH_REPLY_PREFIX = 'slash:';

const SLACK_CAPABILITIES: ChannelCapabilities = {
  edit: true,
  typing: false,
  threads: true,
  maxMessageChars: 4000,
  markdown: false,
  reactions: true,
  nativeCommands: true,
  outboundMirror: true,
  groupMentionPolicy: true
};

// Slack's reactions.add wants an emoji *name* (no colons). Map the acks the core sends.
const EMOJI_NAMES: Record<string, string> = {
  '✅': 'white_check_mark',
  '⚠': 'warning',
  '⏳': 'hourglass_flowing_sand'
};

interface SlackEvent {
  type: string;
  subtype?: string;
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  channel_type?: string;
  bot_id?: string;
}

const slackSlashCommandSchema = z.object({
  channel_id: z.string(),
  channel_name: z.string().optional(),
  command: z.string().regex(/^\/[A-Za-z0-9_-]+$/),
  response_url: z.string().url(),
  text: z.string().default(''),
  user_id: z.string(),
  user_name: z.string().optional()
});
type SlackSlashCommand = z.infer<typeof slackSlashCommandSchema>;

/**
 * Pure normalization of a Slack message event → ChannelInbound. Exported for tests.
 *  - chatType: channel_type 'im' ⇒ dm, 'channel' ⇒ channel, else group (mpim/group).
 *  - mentionedSelf: the text contains the bot's `<@U…>` mention token.
 *  - isSelf: from the bot itself (its user id) or any bot_id (echo guard).
 */
export function normalizeSlackMessage(event: SlackEvent, selfUserId?: string): ChannelInbound {
  const text = event.text ?? '';
  const isCommand = text.startsWith('/');
  const [head, ...args] = isCommand ? text.trim().split(/\s+/) : [];
  const command = head ? head.slice(1).toLowerCase() : undefined;
  const ctype = event.channel_type;
  const chatType = ctype === 'im' ? 'dm' : ctype === 'channel' ? 'channel' : 'group';
  return {
    chatId: event.channel,
    userId: event.user ?? event.channel,
    threadId: event.thread_ts,
    text,
    kind: isCommand ? 'command' : text ? 'text' : 'media',
    command,
    commandArgs: args,
    nativeMessageId: event.ts,
    senderDisplay: event.user,
    chatType,
    mentionedSelf: selfUserId !== undefined && text.includes(`<@${selfUserId}>`),
    isSelf: (selfUserId !== undefined && event.user === selfUserId) || Boolean(event.bot_id),
    media: [],
    at: new Date().toISOString()
  };
}

/** Normalize a Socket Mode slash_commands payload into the shared channel command path. */
export function normalizeSlackSlashCommand(payload: SlackSlashCommand, envelopeId: string): ChannelInbound {
  const args = payload.text.trim() ? payload.text.trim().split(/\s+/) : [];
  const command = payload.command.slice(1).toLowerCase();
  const replyTarget = `${SLASH_REPLY_PREFIX}${envelopeId}`;
  return {
    chatId: payload.channel_id,
    userId: payload.user_id,
    text: `/${command}${payload.text.trim() ? ` ${payload.text.trim()}` : ''}`,
    kind: 'command',
    command,
    commandArgs: args,
    nativeMessageId: replyTarget,
    replyTo: replyTarget,
    senderDisplay: payload.user_name,
    chatType: payload.channel_name === 'directmessage' || payload.channel_id.startsWith('D') ? 'dm' : 'channel',
    mentionedSelf: true,
    isSelf: false,
    media: [],
    at: new Date().toISOString()
  };
}

export function createSlackAdapter(ctx: ChannelContext): ChannelAdapter {
  const token = ctx.secrets.token; // bot token (xoxb-)
  const appToken = ctx.secrets.appToken; // app-level token (xapp-)
  let selfUserId: string | undefined;
  let ws: WebSocket | undefined;
  let backoff = 1000;
  const slashResponses = new Map<string, { responseUrl: string; responded: boolean }>();

  async function web<T>(
    method: string,
    body: unknown,
    schema: { parse(input: unknown): T },
    useAppToken = false
  ): Promise<T> {
    const res = await fetch(`${WEB_API}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${useAppToken ? appToken : token}`,
        'content-type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify(body),
      signal: ctx.signal
    });
    const json = await res.json();
    const envelope = z.object({ ok: z.boolean(), error: z.string().optional() }).parse(json);
    if (!envelope.ok) throw new Error(`slack ${method} failed: ${envelope.error ?? res.status}`);
    return schema.parse(json);
  }

  function ack(envelopeId: string): void {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ envelope_id: envelopeId }));
  }

  function rememberSlashResponse(replyTarget: string, responseUrl: string): void {
    if (slashResponses.size >= 1000) {
      const oldest = slashResponses.keys().next().value;
      if (oldest) slashResponses.delete(oldest);
    }
    slashResponses.set(replyTarget, { responseUrl, responded: false });
  }

  async function respondToSlash(
    replyTarget: string,
    content: string,
    replaceOriginal = false
  ): Promise<SentMessage | null> {
    const pending = slashResponses.get(replyTarget);
    if (!pending) return null;
    const res = await fetch(pending.responseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        response_type: 'ephemeral',
        text: content,
        ...(replaceOriginal ? { replace_original: true } : {})
      }),
      signal: ctx.signal
    });
    if (!res.ok) throw new Error(`slack slash response failed: ${res.status}`);
    pending.responded = true;
    return { ref: replyTarget, chatId: '' };
  }

  function handle(raw: string): void {
    let msg: { type?: string; envelope_id?: string; payload?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // ACK every envelope first (Slack requires it within 3s, else it redelivers).
    if (msg.envelope_id) ack(msg.envelope_id);
    if (msg.type === 'hello') {
      backoff = 1000;
      return;
    }
    if (msg.type === 'disconnect') {
      ws?.close();
      return;
    }
    if (msg.type === 'events_api') {
      const event = (msg.payload as { event?: SlackEvent } | undefined)?.event;
      // Skip edits/joins/etc. (subtype set) — only fresh user messages drive the agent.
      if (event?.type === 'message' && !event.subtype) ctx.onMessage(normalizeSlackMessage(event, selfUserId));
    } else if (msg.type === 'slash_commands' && msg.envelope_id) {
      const command = slackSlashCommandSchema.safeParse(msg.payload);
      if (!command.success) {
        ctx.log('warn', 'slack slash command payload was invalid');
        return;
      }
      const inbound = normalizeSlackSlashCommand(command.data, msg.envelope_id);
      rememberSlashResponse(inbound.replyTo ?? inbound.nativeMessageId, command.data.response_url);
      ctx.onMessage(inbound);
    }
  }

  async function openSocket(): Promise<void> {
    if (ctx.signal.aborted) return;
    try {
      const { url } = await web('apps.connections.open', {}, z.object({ url: z.string() }), true);
      ws = new WebSocket(url);
      ws.onmessage = (ev: MessageEvent) => handle(typeof ev.data === 'string' ? ev.data : '');
      ws.onerror = () => ctx.log('warn', 'slack socket error');
      ws.onclose = () => {
        if (ctx.signal.aborted) return;
        ctx.log('info', `slack socket closed — reconnecting in ${backoff}ms`);
        setTimeout(() => void openSocket(), backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      };
    } catch (err) {
      if (ctx.signal.aborted) return;
      ctx.log('warn', `slack connect error: ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(() => void openSocket(), backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }

  return {
    type: 'slack',
    capabilities: SLACK_CAPABILITIES,

    async connect() {
      if (!appToken)
        throw new Error('slack: missing app-level token (set credential extra.appToken to an xapp-… token)');
      const auth = await web('auth.test', {}, z.object({ user_id: z.string() }));
      selfUserId = auth.user_id;
      void openSocket();
    },

    async disconnect() {
      ws?.close(1000);
    },

    async send(chatId: string, content: string, opts?: SendOptions): Promise<SentMessage> {
      if (opts?.replyTo?.startsWith(SLASH_REPLY_PREFIX)) {
        const response = await respondToSlash(opts.replyTo, content);
        if (!response) throw new Error('slack slash response target is unavailable');
        return { ...response, chatId };
      }
      const res = await web(
        'chat.postMessage',
        {
          channel: chatId,
          text: content,
          thread_ts: opts?.threadId
        },
        z.object({ ts: z.string() })
      );
      return { ref: res.ts, chatId, threadId: opts?.threadId };
    },

    async editMessage(msg: SentMessage, content: string) {
      if (msg.ref.startsWith(SLASH_REPLY_PREFIX)) {
        if (!(await respondToSlash(msg.ref, content, true))) {
          throw new Error('slack slash response target is unavailable');
        }
        return;
      }
      await web('chat.update', { channel: msg.chatId, ts: msg.ref, text: content }, z.object({}).passthrough());
    },

    async setCommands(commands: ChannelNativeCommand[]) {
      ctx.log('info', 'slack slash commands require manual registration in the Slack app', {
        commands: commands.map(({ command }) => `/${command}`)
      });
    },

    async react(target, emoji) {
      if (target.messageId.startsWith(SLASH_REPLY_PREFIX)) {
        const pending = slashResponses.get(target.messageId);
        if (pending && !pending.responded) await respondToSlash(target.messageId, emoji);
        return;
      }
      const name = EMOJI_NAMES[emoji] ?? (/^[a-z0-9_+-]+$/.test(emoji) ? emoji : undefined);
      if (!name) return;
      await web(
        'reactions.add',
        { channel: target.chatId, timestamp: target.messageId, name },
        z.object({}).passthrough()
      );
    }
  };
}

/** First-party Slack channel (Socket Mode), authored with the SDK's defineChannel. */
export const slackChannelAtom = defineChannel({
  type: 'slack',
  name: 'Slack',
  icon: channelIcons.slack,
  setup: channelSetupGuides.slack,
  capabilities: SLACK_CAPABILITIES,
  envVars: [
    {
      name: 'SLACK_BOT_TOKEN',
      description: 'Bot token (xoxb-…) for Web API calls',
      required: true,
      secret: true,
      credentialKey: 'token'
    },
    {
      name: 'SLACK_APP_TOKEN',
      description: 'App-level token (xapp-…) for Socket Mode',
      required: true,
      secret: true,
      credentialKey: 'appToken'
    }
  ],
  create: createSlackAdapter
});
