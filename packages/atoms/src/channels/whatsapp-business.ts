import type { ChannelInbound } from '@monad/protocol';
import type { ChannelAdapter, ChannelCapabilities, ChannelContext, SentMessage } from '@monad/sdk-atom';

import { defineChannel } from '@monad/sdk-atom';
import { z } from 'zod';

import { hmacSha256Hex, serveHttpInbound, timingSafeEqual } from './_http-inbound.ts';
import { channelIcons } from './icons.ts';
import { channelSetupGuides } from './setup-guides.ts';

const WHATSAPP_BUSINESS_CAPABILITIES: ChannelCapabilities = {
  edit: false,
  typing: false,
  threads: false,
  maxMessageChars: 4096,
  markdown: false,
  reactions: false,
  nativeCommands: false,
  outboundMirror: true
};

const messageSchema = z.looseObject({
  from: z.string(),
  id: z.string(),
  type: z.string(),
  text: z.looseObject({ body: z.string() }).optional()
});

const webhookSchema = z.looseObject({
  entry: z
    .array(
      z.looseObject({
        changes: z
          .array(z.looseObject({ value: z.looseObject({ messages: z.array(messageSchema).optional() }).optional() }))
          .optional()
      })
    )
    .optional()
});

type WhatsappBusinessWebhook = z.infer<typeof webhookSchema>;

export function normalizeWhatsappBusinessWebhook(body: WhatsappBusinessWebhook): ChannelInbound[] {
  const out: ChannelInbound[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        if (message.type !== 'text' || !message.text) continue;
        const text = message.text.body;
        const isCommand = text.startsWith('/');
        const [head, ...args] = isCommand ? text.trim().split(/\s+/) : [];
        out.push({
          chatId: message.from,
          userId: message.from,
          text,
          kind: isCommand ? 'command' : 'text',
          command: head ? head.slice(1).toLowerCase() : undefined,
          commandArgs: args,
          nativeMessageId: message.id,
          chatType: 'dm',
          isSelf: false,
          media: [],
          at: new Date().toISOString()
        });
      }
    }
  }
  return out;
}

export function createWhatsappBusinessAdapter(ctx: ChannelContext): ChannelAdapter {
  const token = ctx.secrets.token;
  const appSecret = ctx.secrets.appSecret ?? '';
  const verifyToken = ctx.secrets.verifyToken ?? '';
  const phoneNumberId = ctx.secrets.phoneNumberId ?? '';
  const graphVersion = ctx.secrets.graphVersion || 'v21.0';
  const port = Number(ctx.secrets.port) || 8802;
  const path = ctx.secrets.path || '/whatsapp-business';

  const server = serveHttpInbound(ctx, {
    port,
    path,
    onGet: (url) => {
      if (
        url.searchParams.get('hub.mode') === 'subscribe' &&
        url.searchParams.get('hub.verify_token') === verifyToken
      ) {
        return new Response(url.searchParams.get('hub.challenge') ?? '');
      }
      return new Response('forbidden', { status: 403 });
    },
    verify: appSecret
      ? async (request, raw) => {
          const header = request.headers.get('x-hub-signature-256') ?? '';
          const expected = `sha256=${await hmacSha256Hex(appSecret, raw)}`;
          return timingSafeEqual(header, expected);
        }
      : undefined,
    handle: (raw) => ({ events: normalizeWhatsappBusinessWebhook(webhookSchema.parse(JSON.parse(raw))) })
  });

  return {
    type: 'whatsapp-business',
    capabilities: WHATSAPP_BUSINESS_CAPABILITIES,
    async connect() {
      if (!token || !phoneNumberId) {
        throw new Error('whatsapp-business: access token and phone number ID are required');
      }
      if (!appSecret) {
        ctx.log('warn', 'whatsapp-business: no appSecret; inbound webhook disabled');
        return;
      }
      server.start();
    },
    async disconnect() {
      server.stop();
    },
    async send(chatId: string, content: string): Promise<SentMessage> {
      const response = await fetch(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: chatId, type: 'text', text: { body: content } }),
        signal: ctx.signal
      });
      const json = z
        .object({ messages: z.array(z.object({ id: z.string() })).optional() })
        .parse(await response.json().catch(() => ({})));
      if (!response.ok) throw new Error(`whatsapp-business send failed: ${response.status}`);
      return { ref: json.messages?.[0]?.id ?? `wa-${Date.now()}`, chatId };
    }
  };
}

export const whatsappBusinessChannelAtom = defineChannel({
  type: 'whatsapp-business',
  name: 'WhatsApp Business Cloud API',
  icon: channelIcons.whatsapp,
  setup: channelSetupGuides.whatsappBusiness,
  capabilities: WHATSAPP_BUSINESS_CAPABILITIES,
  envVars: [
    {
      name: 'WHATSAPP_PHONE_NUMBER_ID',
      description: 'Cloud API phone number ID',
      required: true,
      credentialKey: 'phoneNumberId'
    },
    {
      name: 'WHATSAPP_ACCESS_TOKEN',
      description: 'Graph API access token',
      required: true,
      secret: true,
      credentialKey: 'token'
    },
    {
      name: 'WHATSAPP_APP_SECRET',
      description: 'App secret (webhook signature)',
      required: true,
      secret: true,
      credentialKey: 'appSecret'
    },
    {
      name: 'WHATSAPP_VERIFY_TOKEN',
      description: 'Webhook verification token',
      required: true,
      secret: true,
      credentialKey: 'verifyToken'
    },
    {
      name: 'WHATSAPP_GRAPH_VERSION',
      description: 'Graph API version (default v21.0)',
      required: false,
      credentialKey: 'graphVersion'
    },
    { name: 'WHATSAPP_PORT', description: 'Inbound port (default 8802)', required: false, credentialKey: 'port' },
    {
      name: 'WHATSAPP_PATH',
      description: 'Inbound path (default /whatsapp-business)',
      required: false,
      credentialKey: 'path'
    }
  ],
  create: createWhatsappBusinessAdapter
});
