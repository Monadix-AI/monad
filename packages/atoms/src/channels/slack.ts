// Slack channel adapter — Socket Mode for inbound (no public URL needed), Web API for outbound.
// Socket Mode needs TWO credentials: a bot token (xoxb-…, ctx.secrets.token) for Web API calls and
// an app-level token (xapp-…, ctx.secrets.appToken) to open the socket. Store the app token in the
// channel credential's `extra.appToken`. Pure platform I/O: it never touches sessions.

import type { ChannelInbound } from '@monad/protocol';
import type { ChannelAdapter, ChannelCapabilities, ChannelContext, SendOptions, SentMessage } from '@monad/sdk-atom';

import { defineChannel } from '@monad/sdk-atom';

const WEB_API = 'https://slack.com/api';
const MAX_BACKOFF_MS = 30_000;

const SLACK_CAPABILITIES: ChannelCapabilities = {
  edit: true,
  typing: false,
  threads: true,
  maxMessageChars: 4000,
  markdown: false,
  reactions: true,
  nativeCommands: false,
  outboundMirror: true
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

export function createSlackAdapter(ctx: ChannelContext): ChannelAdapter {
  const token = ctx.secrets.token; // bot token (xoxb-)
  const appToken = ctx.secrets.appToken; // app-level token (xapp-)
  let selfUserId: string | undefined;
  let ws: WebSocket | undefined;
  let backoff = 1000;

  async function web<T = Record<string, unknown>>(method: string, body: unknown, useAppToken = false): Promise<T> {
    const res = await fetch(`${WEB_API}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${useAppToken ? appToken : token}`,
        'content-type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify(body),
      signal: ctx.signal
    });
    const json = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!json.ok) throw new Error(`slack ${method} failed: ${json.error ?? res.status}`);
    return json;
  }

  function ack(envelopeId: string): void {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ envelope_id: envelopeId }));
  }

  function handle(raw: string): void {
    let msg: { type?: string; envelope_id?: string; payload?: { event?: SlackEvent } };
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
      const event = msg.payload?.event;
      // Skip edits/joins/etc. (subtype set) — only fresh user messages drive the agent.
      if (event?.type === 'message' && !event.subtype) ctx.onMessage(normalizeSlackMessage(event, selfUserId));
    }
  }

  async function openSocket(): Promise<void> {
    if (ctx.signal.aborted) return;
    try {
      const { url } = await web<{ url: string }>('apps.connections.open', {}, true);
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
      const auth = await web<{ user_id: string }>('auth.test', {});
      selfUserId = auth.user_id;
      void openSocket();
    },

    async disconnect() {
      ws?.close(1000);
    },

    async send(chatId: string, content: string, opts?: SendOptions): Promise<SentMessage> {
      const res = await web<{ ts: string }>('chat.postMessage', {
        channel: chatId,
        text: content,
        thread_ts: opts?.threadId
      });
      return { ref: res.ts, chatId, threadId: opts?.threadId };
    },

    async editMessage(msg: SentMessage, content: string) {
      await web('chat.update', { channel: msg.chatId, ts: msg.ref, text: content });
    },

    async react(target, emoji) {
      const name = EMOJI_NAMES[emoji] ?? (/^[a-z0-9_+-]+$/.test(emoji) ? emoji : undefined);
      if (!name) return;
      await web('reactions.add', { channel: target.chatId, timestamp: target.messageId, name });
    }
  };
}

/** First-party Slack channel (Socket Mode), authored with the SDK's defineChannel. */
export const slackChannelAtom = defineChannel({
  type: 'slack',
  name: 'Slack',
  capabilities: SLACK_CAPABILITIES,
  envVars: [
    { name: 'SLACK_BOT_TOKEN', description: 'Bot token (xoxb-…) for Web API calls', required: true, secret: true },
    { name: 'SLACK_APP_TOKEN', description: 'App-level token (xapp-…) for Socket Mode', required: true, secret: true }
  ],
  create: createSlackAdapter
});
