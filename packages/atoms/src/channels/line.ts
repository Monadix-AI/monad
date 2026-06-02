// LINE channel adapter — Messaging API webhook in, push API out. Inbound POSTs are signed with the
// channel secret (x-line-signature: base64 HMAC-SHA256). Pure platform I/O; never touches sessions.
//
// secrets: token = channel access token (Bearer); extra.channelSecret = for signature verification.
// options: { port?=8801, path?='/line' }

import type { ChannelInbound } from '@monad/protocol';
import type { ChannelAdapter, ChannelCapabilities, ChannelContext, SentMessage } from '@monad/sdk-atom';

import { defineChannel } from '@monad/sdk-atom';
import { z } from 'zod';

import { hmacSha256Base64, serveHttpInbound, timingSafeEqual } from './_http-inbound.ts';

const API = 'https://api.line.me/v2/bot';

const LINE_CAPABILITIES: ChannelCapabilities = {
  edit: false,
  typing: false,
  threads: false,
  maxMessageChars: 5000,
  markdown: false,
  reactions: false,
  nativeCommands: false,
  outboundMirror: true
};

const lineEventSchema = z.looseObject({
  type: z.string(),
  message: z.looseObject({ type: z.string(), id: z.string(), text: z.string().optional() }).optional(),
  source: z
    .looseObject({
      type: z.string(),
      userId: z.string().optional(),
      groupId: z.string().optional(),
      roomId: z.string().optional()
    })
    .optional(),
  timestamp: z.number().optional()
});
type LineEvent = z.infer<typeof lineEventSchema>;

const lineWebhookSchema = z.looseObject({ events: z.array(lineEventSchema).optional() });

/** Normalize one LINE webhook event → ChannelInbound, or null if it isn't a text message. The chat
 *  is keyed by group/room id in a group, else the user id (a 1:1 chat). Exported for tests. */
export function normalizeLineEvent(event: LineEvent): ChannelInbound | null {
  if (event.type !== 'message' || event.message?.type !== 'text') return null;
  const src = event.source;
  const chatId = src?.groupId ?? src?.roomId ?? src?.userId ?? '';
  const chatType = src?.groupId || src?.roomId ? 'group' : 'dm';
  const text = event.message.text ?? '';
  const isCommand = text.startsWith('/');
  const [head, ...args] = isCommand ? text.trim().split(/\s+/) : [];
  return {
    chatId,
    userId: src?.userId ?? chatId,
    text,
    kind: isCommand ? 'command' : 'text',
    command: head ? head.slice(1).toLowerCase() : undefined,
    commandArgs: args,
    nativeMessageId: event.message.id,
    chatType,
    isSelf: false,
    media: [],
    at: event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString()
  };
}

export function createLineAdapter(ctx: ChannelContext): ChannelAdapter {
  const token = ctx.secrets.token;
  const channelSecret = ctx.secrets.channelSecret ?? '';
  const port = Number(ctx.config.options.port) || 8801;
  const path = (typeof ctx.config.options.path === 'string' ? ctx.config.options.path : '/line') || '/line';

  const server = serveHttpInbound(ctx, {
    port,
    path,
    verify: channelSecret
      ? async (req, raw) => {
          const sig = req.headers.get('x-line-signature') ?? '';
          return timingSafeEqual(sig, await hmacSha256Base64(channelSecret, raw));
        }
      : undefined,
    handle: (raw) => {
      const body = lineWebhookSchema.parse(JSON.parse(raw));
      const events = (body.events ?? []).map(normalizeLineEvent).filter((e): e is ChannelInbound => e !== null);
      return { events };
    }
  });

  return {
    type: 'line',
    capabilities: LINE_CAPABILITIES,
    async connect() {
      if (!token) throw new Error('line: missing channel access token');
      // channelSecret gates inbound signature verification only (outbound uses the Bearer token).
      // Without it, run OUTBOUND-ONLY and don't start the unsigned (spoofable) webhook listener.
      if (!channelSecret) {
        ctx.log(
          'warn',
          'line: no channelSecret — outbound-only; inbound webhook disabled (set extra.channelSecret to receive)'
        );
        return;
      }
      server.start();
    },
    async disconnect() {
      server.stop();
    },
    async send(chatId: string, content: string): Promise<SentMessage> {
      const res = await fetch(`${API}/message/push`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ to: chatId, messages: [{ type: 'text', text: content }] }),
        signal: ctx.signal
      });
      if (!res.ok) throw new Error(`line push failed: ${res.status}`);
      return { ref: `line-${Date.now()}`, chatId };
    }
  };
}

export const lineChannelAtom = defineChannel({
  type: 'line',
  name: 'LINE',
  capabilities: LINE_CAPABILITIES,
  envVars: [
    { name: 'LINE_CHANNEL_ACCESS_TOKEN', description: 'Channel access token (Bearer)', required: true, secret: true },
    { name: 'LINE_CHANNEL_SECRET', description: 'Channel secret (webhook signature)', required: true, secret: true }
  ],
  create: createLineAdapter
});
