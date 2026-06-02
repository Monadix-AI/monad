// Feishu / Lark channel adapter — event webhook in, IM API out (tenant-token auth). Handles the
// url_verification handshake; messages arrive as event v2 (im.message.receive_v1). Pure platform I/O.
//
// secrets: extra.appId + extra.appSecret (tenant token exchange). options: { port?=8804, path?='/feishu',
//   baseUrl?='https://open.feishu.cn' }  (use https://open.larksuite.com for Lark international).

import type { ChannelInbound } from '@monad/protocol';
import type { ChannelAdapter, ChannelCapabilities, ChannelContext, SentMessage } from '@monad/sdk-atom';

import { defineChannel } from '@monad/sdk-atom';
import { z } from 'zod';

import { serveHttpInbound, timingSafeEqual } from './_http-inbound.ts';

const FEISHU_CAPABILITIES: ChannelCapabilities = {
  edit: false,
  typing: false,
  threads: false,
  maxMessageChars: 10_000,
  markdown: false,
  reactions: false,
  nativeCommands: false,
  outboundMirror: true
};

const feishuEventSchema = z.looseObject({
  header: z.looseObject({ event_type: z.string().optional() }).optional(),
  event: z
    .looseObject({
      message: z
        .looseObject({
          message_id: z.string(),
          chat_id: z.string(),
          chat_type: z.string().optional(),
          message_type: z.string().optional(),
          content: z.string().optional()
        })
        .optional(),
      sender: z.looseObject({ sender_id: z.looseObject({ open_id: z.string().optional() }).optional() }).optional()
    })
    .optional()
});
type FeishuEvent = z.infer<typeof feishuEventSchema>;

// The webhook body is an event plus handshake/encryption envelope fields.
const feishuWebhookSchema = feishuEventSchema.extend({
  type: z.string().optional(),
  challenge: z.string().optional(),
  encrypt: z.string().optional()
});

const feishuTextContentSchema = z.looseObject({ text: z.string().optional() });

/** Normalize a Feishu im.message.receive_v1 event → ChannelInbound, or null. Text lives JSON-encoded
 *  in `message.content` (`{"text":"…"}`). Exported for tests. */
export function normalizeFeishuMessage(body: FeishuEvent): ChannelInbound | null {
  if (body.header?.event_type !== 'im.message.receive_v1') return null;
  const msg = body.event?.message;
  if (msg?.message_type !== 'text') return null;
  let text = '';
  try {
    text = feishuTextContentSchema.parse(JSON.parse(msg.content ?? '{}')).text ?? '';
  } catch {
    /* leave empty */
  }
  const isCommand = text.startsWith('/');
  const [head, ...args] = isCommand ? text.trim().split(/\s+/) : [];
  return {
    chatId: msg.chat_id,
    userId: body.event?.sender?.sender_id?.open_id ?? msg.chat_id,
    text,
    kind: isCommand ? 'command' : 'text',
    command: head ? head.slice(1).toLowerCase() : undefined,
    commandArgs: args,
    nativeMessageId: msg.message_id,
    chatType: msg.chat_type === 'p2p' ? 'dm' : 'group',
    isSelf: false,
    media: [],
    at: new Date().toISOString()
  };
}

export function createFeishuAdapter(ctx: ChannelContext): ChannelAdapter {
  const appId = ctx.secrets.appId ?? '';
  const appSecret = ctx.secrets.appSecret ?? '';
  const encryptKey = ctx.secrets.encryptKey ?? '';
  const baseUrl = (
    typeof ctx.config.options.baseUrl === 'string' ? ctx.config.options.baseUrl : 'https://open.feishu.cn'
  ).replace(/\/+$/, '');
  const port = Number(ctx.config.options.port) || 8804;
  const path = (typeof ctx.config.options.path === 'string' ? ctx.config.options.path : '/feishu') || '/feishu';

  let cached: { token: string; exp: number } | undefined;
  async function tenantToken(): Promise<string> {
    if (cached && cached.exp > Date.now()) return cached.token;
    const res = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: ctx.signal
    });
    const json = (await res.json()) as { tenant_access_token?: string; expire?: number; msg?: string };
    if (!json.tenant_access_token) throw new Error(`feishu token failed: ${json.msg ?? res.status}`);
    cached = { token: json.tenant_access_token, exp: Date.now() + (json.expire ?? 7200) * 1000 - 60_000 };
    return cached.token;
  }

  const server = serveHttpInbound(ctx, {
    port,
    path,
    // When an encrypt key is configured, verify Feishu's request signature
    // sha256(timestamp + nonce + encryptKey + rawBody) over the raw body before parsing.
    verify: encryptKey
      ? async (req, raw) => {
          const sig = req.headers.get('x-lark-signature') ?? '';
          const ts = req.headers.get('x-lark-request-timestamp') ?? '';
          const nonce = req.headers.get('x-lark-request-nonce') ?? '';
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ts + nonce + encryptKey + raw));
          const expected = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
          return timingSafeEqual(sig, expected);
        }
      : undefined,
    handle: (raw) => {
      const body = feishuWebhookSchema.parse(JSON.parse(raw));
      // We don't decrypt AES-wrapped events (like hermes). If the app has encryption ON, turn it OFF
      // in the Feishu console (signature verification alone is sufficient) — otherwise events arrive
      // as an opaque `encrypt` blob we can't read.
      if (body.encrypt)
        throw new Error('feishu: encrypted events are not supported — disable encryption in the app console');
      // URL-verification handshake — echo the challenge.
      if (body.type === 'url_verification' && body.challenge) {
        return { response: Response.json({ challenge: body.challenge }) };
      }
      const ev = normalizeFeishuMessage(body);
      return { events: ev ? [ev] : [] };
    }
  });

  return {
    type: 'feishu',
    capabilities: FEISHU_CAPABILITIES,
    async connect() {
      if (!appId || !appSecret) throw new Error('feishu: extra.appId and extra.appSecret are required');
      // encryptKey gates inbound request-signature verification only (appId/appSecret drive outbound
      // tenant-token exchange). Without it, run OUTBOUND-ONLY and don't start the unsigned listener.
      if (!encryptKey) {
        ctx.log(
          'warn',
          'feishu: no encryptKey — outbound-only; inbound webhook disabled (set extra.encryptKey to receive)'
        );
        return;
      }
      server.start();
    },
    async disconnect() {
      server.stop();
    },
    async send(chatId: string, content: string): Promise<SentMessage> {
      const token = await tenantToken();
      const res = await fetch(`${baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: content }) }),
        signal: ctx.signal
      });
      const json = (await res.json().catch(() => ({}))) as { data?: { message_id?: string }; msg?: string };
      if (!res.ok) throw new Error(`feishu send failed: ${json.msg ?? res.status}`);
      return { ref: json.data?.message_id ?? `fs-${Date.now()}`, chatId };
    }
  };
}

export const feishuChannelAtom = defineChannel({
  type: 'feishu',
  name: 'Feishu / Lark',
  capabilities: FEISHU_CAPABILITIES,
  envVars: [
    { name: 'FEISHU_APP_ID', description: 'App ID', required: true, secret: true },
    { name: 'FEISHU_APP_SECRET', description: 'App secret', required: true, secret: true }
  ],
  create: createFeishuAdapter
});
