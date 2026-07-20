// WhatsApp Cloud API channel adapter — Meta Graph webhook in, Graph API out. A GET handshake echoes
// hub.challenge; POSTs are signed (x-hub-signature-256: sha256=<hex> over the raw body, keyed by the
// app secret). Pure platform I/O; never touches sessions.
//
// secrets: token = Graph API access token; extra.appSecret = signature key; extra.verifyToken = GET handshake.
// options: { phoneNumberId, port?=8802, path?='/whatsapp', graphVersion?='v21.0' }

import type { ChannelInbound } from '@monad/protocol';
import type { ChannelAdapter, ChannelCapabilities, ChannelContext, SentMessage } from '@monad/sdk-atom';

import { defineChannel } from '@monad/sdk-atom';
import { z } from 'zod';

import { hmacSha256Hex, serveHttpInbound, timingSafeEqual } from './_http-inbound.ts';

const WHATSAPP_CAPABILITIES: ChannelCapabilities = {
  edit: false,
  typing: false,
  threads: false,
  maxMessageChars: 4096,
  markdown: false,
  reactions: false,
  nativeCommands: false,
  outboundMirror: true
};

const waMessageSchema = z.looseObject({
  from: z.string(),
  id: z.string(),
  type: z.string(),
  text: z.looseObject({ body: z.string() }).optional()
});

const waWebhookSchema = z.looseObject({
  entry: z
    .array(
      z.looseObject({
        changes: z
          .array(z.looseObject({ value: z.looseObject({ messages: z.array(waMessageSchema).optional() }).optional() }))
          .optional()
      })
    )
    .optional()
});

type WaWebhook = z.infer<typeof waWebhookSchema>;

/** Flatten a WhatsApp webhook body into normalized text inbounds. Exported for tests. */
export function normalizeWhatsappWebhook(body: WaWebhook): ChannelInbound[] {
  const out: ChannelInbound[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const m of change.value?.messages ?? []) {
        if (m.type !== 'text' || !m.text) continue;
        const text = m.text.body;
        const isCommand = text.startsWith('/');
        const [head, ...args] = isCommand ? text.trim().split(/\s+/) : [];
        out.push({
          chatId: m.from,
          userId: m.from,
          text,
          kind: isCommand ? 'command' : 'text',
          command: head ? head.slice(1).toLowerCase() : undefined,
          commandArgs: args,
          nativeMessageId: m.id,
          chatType: 'dm', // WhatsApp Cloud API delivers 1:1 customer messages
          isSelf: false,
          media: [],
          at: new Date().toISOString()
        });
      }
    }
  }
  return out;
}

export function createWhatsappAdapter(ctx: ChannelContext): ChannelAdapter {
  const token = ctx.secrets.token;
  const appSecret = ctx.secrets.appSecret ?? '';
  const verifyToken = ctx.secrets.verifyToken ?? '';
  const phoneNumberId = String(ctx.config.options.phoneNumberId ?? '');
  const graphVersion = typeof ctx.config.options.graphVersion === 'string' ? ctx.config.options.graphVersion : 'v21.0';
  const port = Number(ctx.config.options.port) || 8802;
  const path = (typeof ctx.config.options.path === 'string' ? ctx.config.options.path : '/whatsapp') || '/whatsapp';

  const server = serveHttpInbound(ctx, {
    port,
    path,
    onGet: (url) => {
      // Meta verification handshake: echo hub.challenge when the verify token matches.
      if (
        url.searchParams.get('hub.mode') === 'subscribe' &&
        url.searchParams.get('hub.verify_token') === verifyToken
      ) {
        return new Response(url.searchParams.get('hub.challenge') ?? '');
      }
      return new Response('forbidden', { status: 403 });
    },
    verify: appSecret
      ? async (req, raw) => {
          const header = req.headers.get('x-hub-signature-256') ?? '';
          const expected = `sha256=${await hmacSha256Hex(appSecret, raw)}`;
          return timingSafeEqual(header, expected);
        }
      : undefined,
    handle: (raw) => ({ events: normalizeWhatsappWebhook(waWebhookSchema.parse(JSON.parse(raw))) })
  });

  return {
    type: 'whatsapp',
    capabilities: WHATSAPP_CAPABILITIES,
    async connect() {
      if (!token || !phoneNumberId) throw new Error('whatsapp: token and options.phoneNumberId are required');
      // appSecret keys the inbound signature check. Without it we run OUTBOUND-ONLY (send still works
      // via token) and do NOT start the webhook listener — an unsigned listener would accept spoofed
      // payloads whose body asserts the sender identity the allowlist trusts.
      if (!appSecret) {
        ctx.log(
          'warn',
          'whatsapp: no appSecret — outbound-only; inbound webhook disabled (set extra.appSecret to receive)'
        );
        return;
      }
      server.start();
    },
    async disconnect() {
      server.stop();
    },
    async send(chatId: string, content: string): Promise<SentMessage> {
      const res = await fetch(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: chatId, type: 'text', text: { body: content } }),
        signal: ctx.signal
      });
      const json = z
        .object({ messages: z.array(z.object({ id: z.string() })).optional() })
        .parse(await res.json().catch(() => ({})));
      if (!res.ok) throw new Error(`whatsapp send failed: ${res.status}`);
      return { ref: json.messages?.[0]?.id ?? `wa-${Date.now()}`, chatId };
    }
  };
}

export const whatsappChannelAtom = defineChannel({
  type: 'whatsapp',
  name: 'WhatsApp (Cloud API)',
  capabilities: WHATSAPP_CAPABILITIES,
  envVars: [
    { name: 'WHATSAPP_ACCESS_TOKEN', description: 'Graph API access token', required: true, secret: true },
    { name: 'WHATSAPP_APP_SECRET', description: 'App secret (webhook signature)', required: true, secret: true }
  ],
  create: createWhatsappAdapter
});
