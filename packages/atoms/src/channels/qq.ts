// QQ official Bot adapter — Gateway WebSocket (Discord-shaped: op codes, heartbeat, identify) for
// inbound, REST for outbound. QQ has FOUR messaging surfaces with different id schemes and two auth
// schemes: guild channel / guild DM use `Bot {appId}.{token}`; group / C2C (single-chat) use an
// AppAccessToken (`QQBot {token}`). Passive replies need the originating undefined (5-min window), so we
// remember a per-chat reply context. Pure platform I/O; never touches sessions.
//
// secrets: extra.appId, extra.token (Bot token), extra.clientSecret (AppSecret, for AppAccessToken).
// options: { sandbox?=false }

import type { ChannelInbound } from '@monad/protocol';
import type { ChannelAdapter, ChannelCapabilities, ChannelContext, SentMessage } from '@monad/sdk-atom';

import { defineChannel } from '@monad/sdk-atom';

const MAX_BACKOFF_MS = 30_000;
// GUILDS(1<<0) | DIRECT_MESSAGE(1<<12) | GROUP_AND_C2C_EVENT(1<<25) | PUBLIC_GUILD_MESSAGES(1<<30).
const INTENTS = (1 << 0) | (1 << 12) | (1 << 25) | (1 << 30);

const QQ_CAPABILITIES: ChannelCapabilities = {
  edit: false,
  typing: false,
  threads: false,
  maxMessageChars: 2000,
  markdown: false,
  reactions: false,
  nativeCommands: false,
  outboundMirror: true
};

type QQSurface = 'guild' | 'dm' | 'group' | 'c2c';

interface QQPayload {
  id?: string;
  content?: string;
  channel_id?: string;
  guild_id?: string;
  group_openid?: string;
  author?: { id?: string; username?: string; bot?: boolean; member_openid?: string; user_openid?: string };
  timestamp?: string;
}

export interface QQNormalized {
  inbound: ChannelInbound;
  surface: QQSurface;
  msgId: string;
}

/** Normalize a QQ dispatch (event type + payload) into a ChannelInbound plus the reply context
 *  (surface + undefined) the adapter needs to answer on the right endpoint. Returns null for events we
 *  don't handle. Exported for tests. */
export function normalizeQQMessage(t: string, d: QQPayload): QQNormalized | null {
  let surface: QQSurface;
  let chatId: string;
  let userId: string;
  let chatType: 'dm' | 'group';
  switch (t) {
    case 'AT_MESSAGE_CREATE':
    case 'MESSAGE_CREATE':
      surface = 'guild';
      chatId = d.channel_id ?? '';
      userId = d.author?.id ?? chatId;
      chatType = 'group';
      break;
    case 'DIRECT_MESSAGE_CREATE':
      surface = 'dm';
      chatId = d.guild_id ?? ''; // guild DMs reply to /dms/{guild_id}/messages
      userId = d.author?.id ?? chatId;
      chatType = 'dm';
      break;
    case 'GROUP_AT_MESSAGE_CREATE':
      surface = 'group';
      chatId = d.group_openid ?? '';
      userId = d.author?.member_openid ?? chatId;
      chatType = 'group';
      break;
    case 'C2C_MESSAGE_CREATE':
      surface = 'c2c';
      chatId = d.author?.user_openid ?? '';
      userId = chatId;
      chatType = 'dm';
      break;
    default:
      return null;
  }
  if (!chatId) return null;
  const text = (d.content ?? '').trim();
  const isCommand = text.startsWith('/');
  const [head, ...args] = isCommand ? text.split(/\s+/) : [];
  return {
    inbound: {
      chatId,
      userId,
      text,
      kind: isCommand ? 'command' : 'text',
      command: head ? head.slice(1).toLowerCase() : undefined,
      commandArgs: args,
      nativeMessageId: d.id ?? `qq-${Date.now()}`,
      senderDisplay: d.author?.username,
      chatType,
      // An AT_/group-at event is by definition addressed to the bot.
      mentionedSelf: t === 'AT_MESSAGE_CREATE' || t === 'GROUP_AT_MESSAGE_CREATE' || chatType === 'dm',
      isSelf: d.author?.bot === true,
      media: [],
      at: d.timestamp ?? new Date().toISOString()
    },
    surface,
    msgId: d.id ?? ''
  };
}

export function createQQAdapter(ctx: ChannelContext): ChannelAdapter {
  const appId = ctx.secrets.appId ?? '';
  const token = ctx.secrets.token ?? '';
  const clientSecret = ctx.secrets.clientSecret ?? '';
  const sandbox = ctx.config.options.sandbox === true;
  const api = sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com';

  let ws: WebSocket | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let seq: number | null = null;
  let backoff = 1000;
  // Per-chat reply context so a passive reply hits the right endpoint with the right undefined.
  const replyCtx = new Map<string, { surface: QQSurface; msgId: string }>();

  let appToken: { token: string; exp: number } | undefined;
  async function appAccessToken(): Promise<string> {
    if (appToken && appToken.exp > Date.now()) return appToken.token;
    const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret }),
      signal: ctx.signal
    });
    const json = (await res.json()) as { access_token?: string; expires_in?: number | string; message?: string };
    if (!json.access_token) throw new Error(`qq app token failed: ${json.message ?? res.status}`);
    appToken = { token: json.access_token, exp: Date.now() + Number(json.expires_in ?? 7200) * 1000 - 60_000 };
    return appToken.token;
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

  function handle(raw: string): void {
    let p: { op: number; d?: unknown; s?: number | null; t?: string };
    try {
      p = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof p.s === 'number') seq = p.s;
    switch (p.op) {
      case 10: {
        const interval = (p.d as { heartbeat_interval: number }).heartbeat_interval;
        stopHeartbeat();
        heartbeat = setInterval(() => sendOp(1, seq), interval);
        sendOp(2, { token: `Bot ${appId}.${token}`, intents: INTENTS, shard: [0, 1] });
        break;
      }
      case 0: {
        if (p.t === 'READY') {
          backoff = 1000;
        } else if (p.t) {
          const norm = normalizeQQMessage(p.t, p.d as QQPayload);
          if (norm) {
            replyCtx.set(norm.inbound.chatId, { surface: norm.surface, msgId: norm.msgId });
            ctx.onMessage(norm.inbound);
          }
        }
        break;
      }
      case 7:
      case 9:
        ws?.close(4000);
        break;
      default:
        break;
    }
  }

  async function openGateway(): Promise<void> {
    if (ctx.signal.aborted) return;
    seq = null;
    try {
      const res = await fetch(`${api}/gateway/bot`, {
        headers: { authorization: `Bot ${appId}.${token}` },
        signal: ctx.signal
      });
      const { url } = (await res.json()) as { url?: string };
      ws = new WebSocket(url ?? 'wss://api.sgroup.qq.com/websocket');
      ws.onmessage = (ev: MessageEvent) => handle(typeof ev.data === 'string' ? ev.data : '');
      ws.onerror = () => ctx.log('warn', 'qq gateway socket error');
      ws.onclose = () => {
        stopHeartbeat();
        if (ctx.signal.aborted) return;
        ctx.log('info', `qq gateway closed — reconnecting in ${backoff}ms`);
        setTimeout(() => void openGateway(), backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      };
    } catch (err) {
      if (ctx.signal.aborted) return;
      ctx.log('warn', `qq connect error: ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(() => void openGateway(), backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }

  return {
    type: 'qq',
    capabilities: QQ_CAPABILITIES,

    async connect() {
      if (!appId || !token) throw new Error('qq: extra.appId and extra.token are required');
      await openGateway();
    },
    async disconnect() {
      stopHeartbeat();
      ws?.close(1000);
    },

    async send(chatId: string, content: string): Promise<SentMessage> {
      const rc = replyCtx.get(chatId);
      if (!rc)
        throw new Error(`qq: no reply context for ${chatId} (reply only within the passive window after an inbound)`);
      if (rc.surface === 'guild' || rc.surface === 'dm') {
        // Guild channel / guild DM — Bot token auth.
        const base = rc.surface === 'guild' ? `${api}/channels/${chatId}/messages` : `${api}/dms/${chatId}/messages`;
        const res = await fetch(base, {
          method: 'POST',
          headers: { authorization: `Bot ${appId}.${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ content, msg_id: rc.msgId }),
          signal: ctx.signal
        });
        if (!res.ok) throw new Error(`qq send failed: ${res.status}`);
      } else {
        // Group / C2C — AppAccessToken auth, undefined 0 = text.
        const base =
          rc.surface === 'group' ? `${api}/v2/groups/${chatId}/messages` : `${api}/v2/users/${chatId}/messages`;
        const res = await fetch(base, {
          method: 'POST',
          headers: { authorization: `QQBot ${await appAccessToken()}`, 'content-type': 'application/json' },
          body: JSON.stringify({ content, msg_type: 0, msg_id: rc.msgId }),
          signal: ctx.signal
        });
        if (!res.ok) throw new Error(`qq send failed: ${res.status}`);
      }
      return { ref: `qq-${Date.now()}`, chatId };
    }
  };
}

export const qqChannelAtom = defineChannel({
  type: 'qq',
  name: 'QQ Bot',
  capabilities: QQ_CAPABILITIES,
  envVars: [
    { name: 'QQ_APP_ID', description: 'Bot AppID', required: true, secret: true },
    { name: 'QQ_TOKEN', description: 'Bot token', required: true, secret: true },
    { name: 'QQ_CLIENT_SECRET', description: 'AppSecret (for group/C2C AppAccessToken)', required: false, secret: true }
  ],
  create: createQQAdapter
});
