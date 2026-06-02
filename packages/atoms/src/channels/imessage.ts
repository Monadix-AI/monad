// iMessage channel adapter — via a self-hosted BlueBubbles server (the compliant macOS bridge; no
// Apple bot API exists). BlueBubbles POSTs webhook events here for inbound and exposes a REST API for
// outbound. Pure platform I/O; never touches sessions.
//
// secrets: token = BlueBubbles server password (outbound REST + optional inbound shared secret).
// options: { serverUrl, port?=8808, path?='/imessage' }  — serverUrl is the BlueBubbles base URL.

import type { ChannelInbound } from '@monad/protocol';
import type { ChannelAdapter, ChannelCapabilities, ChannelContext, SentMessage } from '@monad/sdk-atom';

import { defineChannel } from '@monad/sdk-atom';
import { z } from 'zod';

import { serveHttpInbound, timingSafeEqual } from './_http-inbound.ts';

const IMESSAGE_CAPABILITIES: ChannelCapabilities = {
  edit: false,
  typing: false,
  threads: false,
  maxMessageChars: 10_000,
  markdown: false,
  reactions: false,
  nativeCommands: false,
  outboundMirror: true
};

const blueBubblesEventSchema = z.looseObject({
  type: z.string().optional(),
  data: z
    .looseObject({
      guid: z.string().optional(),
      text: z.string().optional(),
      isFromMe: z.boolean().optional(),
      handle: z.looseObject({ address: z.string().optional() }).nullable().optional(),
      chats: z
        .array(
          z.looseObject({
            guid: z.string().optional(),
            style: z.number().optional(),
            displayName: z.string().optional()
          })
        )
        .optional(),
      dateCreated: z.number().optional()
    })
    .optional()
});
type BlueBubblesEvent = z.infer<typeof blueBubblesEventSchema>;

/** Normalize a BlueBubbles `new-message` webhook → ChannelInbound, or null. iMessage chat `style`
 *  43 = group, 45 = 1:1. The chat is keyed by its guid. Exported for tests. */
export function normalizeBlueBubblesEvent(body: BlueBubblesEvent): ChannelInbound | null {
  if (body.type !== 'new-message' || !body.data) return null;
  const d = body.data;
  const chat = d.chats?.[0];
  const chatId = chat?.guid;
  if (!chatId) return null;
  const text = d.text ?? '';
  const isCommand = text.startsWith('/');
  const [head, ...args] = isCommand ? text.trim().split(/\s+/) : [];
  return {
    chatId,
    userId: d.handle?.address ?? chatId,
    text,
    kind: isCommand ? 'command' : text ? 'text' : 'media',
    command: head ? head.slice(1).toLowerCase() : undefined,
    commandArgs: args,
    nativeMessageId: d.guid ?? `bb-${Date.now()}`,
    chatType: chat?.style === 43 ? 'group' : 'dm',
    isSelf: d.isFromMe === true,
    media: [],
    at: d.dateCreated ? new Date(d.dateCreated).toISOString() : new Date().toISOString()
  };
}

export function createImessageAdapter(ctx: ChannelContext): ChannelAdapter {
  const password = ctx.secrets.token ?? '';
  const serverUrl = (typeof ctx.config.options.serverUrl === 'string' ? ctx.config.options.serverUrl : '').replace(
    /\/+$/,
    ''
  );
  const inboundSecret = ctx.secrets.inboundSecret ?? '';
  const port = Number(ctx.config.options.port) || 8808;
  const path = (typeof ctx.config.options.path === 'string' ? ctx.config.options.path : '/imessage') || '/imessage';

  const server = serveHttpInbound(ctx, {
    port,
    path,
    // BlueBubbles webhooks aren't signed; if the operator sets an inbound secret, require it as
    // ?password= / ?guid= / x-bb-secret to keep the endpoint from being driven by anyone. With no
    // secret this is a deliberately unverified local bridge, so opt out of the fail-closed default.
    allowUnverified: !inboundSecret,
    verify: inboundSecret
      ? (req) => {
          const url = new URL(req.url);
          const provided =
            req.headers.get('x-bb-secret') ?? url.searchParams.get('password') ?? url.searchParams.get('guid') ?? '';
          return timingSafeEqual(provided, inboundSecret);
        }
      : undefined,
    handle: (raw) => {
      const ev = normalizeBlueBubblesEvent(blueBubblesEventSchema.parse(JSON.parse(raw)));
      return { events: ev ? [ev] : [] };
    }
  });

  return {
    type: 'imessage',
    capabilities: IMESSAGE_CAPABILITIES,
    async connect() {
      if (!serverUrl || !password)
        throw new Error('imessage: options.serverUrl and the BlueBubbles password (token) are required');
      try {
        const h = new URL(serverUrl).hostname.toLowerCase();
        const isLocal =
          h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.startsWith('192.168.') || h.endsWith('.local');
        if (!isLocal)
          ctx.log(
            'warn',
            'imessage: BlueBubbles serverUrl is not localhost — the password travels in plain HTTP query params; use a local tunnel (ngrok/Cloudflare) with TLS termination'
          );
      } catch {
        /* invalid URL caught by the next fetch */
      }
      server.start();
    },
    async disconnect() {
      server.stop();
    },
    async send(chatId: string, content: string): Promise<SentMessage> {
      const res = await fetch(`${serverUrl}/api/v1/message/text?password=${encodeURIComponent(password)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatGuid: chatId, message: content, method: 'private-api' }),
        signal: ctx.signal
      });
      const json = (await res.json().catch(() => ({}))) as { data?: { guid?: string } };
      if (!res.ok) throw new Error(`imessage send failed: ${res.status}`);
      return { ref: json.data?.guid ?? `bb-${Date.now()}`, chatId };
    }
  };
}

export const imessageChannelAtom = defineChannel({
  type: 'imessage',
  name: 'iMessage (BlueBubbles)',
  capabilities: IMESSAGE_CAPABILITIES,
  envVars: [{ name: 'BLUEBUBBLES_PASSWORD', description: 'BlueBubbles server password', required: true, secret: true }],
  create: createImessageAdapter
});
