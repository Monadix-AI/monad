// Generic webhook channel — the escape hatch for any platform without a first-party adapter. Unlike
// Telegram (long-poll) and Discord/Slack (dial-out WebSocket), this one LISTENS: it stands up a small
// HTTP server for inbound and POSTs replies to a configured callback URL for outbound. A shared
// secret (ctx.secrets.token) authenticates both directions. Pure platform I/O: no session access.
//
// options: { port?: number=8788, path?: string='/inbound', outboundUrl?: string }
// inbound  POST {path}  body: { chatId, userId, text, messageId?, senderDisplay?, chatType?, threadId? }
//          header `x-monad-secret: <token>` (or ?secret=) must match.
// outbound POST {outboundUrl} body: { chatId, content, threadId?, replyTo? } + the same secret header.

import type { ChannelInbound } from '@monad/protocol';
import type { ChannelAdapter, ChannelCapabilities, ChannelContext, SendOptions, SentMessage } from '@monad/sdk-atom';

import { defineChannel } from '@monad/sdk-atom';
import { z } from 'zod';

import { timingSafeEqual } from './_http-inbound.ts';

const WEBHOOK_CAPABILITIES: ChannelCapabilities = {
  edit: false,
  typing: false,
  threads: false,
  maxMessageChars: 100_000,
  markdown: false,
  reactions: false,
  nativeCommands: false,
  outboundMirror: true
};

const optionalStringSchema = z.string().optional().catch(undefined);
const webhookPayloadSchema = z.object({
  chatId: z.string().min(1),
  userId: z.string().min(1),
  text: optionalStringSchema,
  messageId: optionalStringSchema,
  senderDisplay: optionalStringSchema,
  chatType: z.enum(['group', 'channel', 'dm']).optional().catch(undefined),
  threadId: optionalStringSchema
});

/** Validate + normalize an untrusted webhook body → ChannelInbound. Throws on a missing chatId/userId.
 *  Exported for tests. A leading `/` marks a command, matching the other channels. */
export function normalizeWebhookPayload(input: unknown, seq: number): ChannelInbound {
  const body = webhookPayloadSchema.parse(input);
  const text = body.text ?? '';
  const isCommand = text.startsWith('/');
  const [head, ...args] = isCommand ? text.trim().split(/\s+/) : [];
  const command = head ? head.slice(1).toLowerCase() : undefined;
  const chatType = body.chatType ?? 'dm';
  return {
    chatId: body.chatId,
    userId: body.userId,
    threadId: body.threadId,
    text,
    kind: isCommand ? 'command' : text ? 'text' : 'media',
    command,
    commandArgs: args,
    nativeMessageId: body.messageId ?? `wh-${seq}`,
    senderDisplay: body.senderDisplay,
    chatType,
    isSelf: false,
    media: [],
    at: new Date().toISOString()
  };
}

export function createWebhookAdapter(ctx: ChannelContext): ChannelAdapter {
  const secret = ctx.secrets.token ?? '';
  const port = Number(ctx.config.options.port) || 8788;
  const path = (typeof ctx.config.options.path === 'string' ? ctx.config.options.path : '/inbound') || '/inbound';
  const outboundUrl = typeof ctx.config.options.outboundUrl === 'string' ? ctx.config.options.outboundUrl : undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let seq = 0;

  return {
    type: 'webhook',
    capabilities: WEBHOOK_CAPABILITIES,

    async connect() {
      server = Bun.serve({
        port,
        fetch: async (req) => {
          const url = new URL(req.url);
          if (req.method !== 'POST' || url.pathname !== path) return new Response('not found', { status: 404 });
          const provided = req.headers.get('x-monad-secret') ?? url.searchParams.get('secret') ?? '';
          if (!secret || !timingSafeEqual(provided, secret)) return new Response('unauthorized', { status: 401 });
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return new Response('bad json', { status: 400 });
          }
          try {
            ctx.onMessage(normalizeWebhookPayload(body, ++seq));
          } catch (err) {
            return new Response(err instanceof Error ? err.message : 'bad payload', { status: 400 });
          }
          return new Response(null, { status: 202 });
        }
      });
      ctx.log('info', `webhook listening on :${port}${path}`);
    },

    async disconnect() {
      server?.stop(true);
      server = undefined;
    },

    async send(chatId: string, content: string, opts?: SendOptions): Promise<SentMessage> {
      const ref = `wh-out-${++seq}`;
      if (!outboundUrl) {
        ctx.log('warn', 'webhook send dropped: no options.outboundUrl configured');
        return { ref, chatId };
      }
      await fetch(outboundUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-monad-secret': secret },
        body: JSON.stringify({ chatId, content, threadId: opts?.threadId, replyTo: opts?.replyTo }),
        signal: ctx.signal
      }).catch((err) =>
        ctx.log('warn', `webhook outbound failed: ${err instanceof Error ? err.message : String(err)}`)
      );
      return { ref, chatId, threadId: opts?.threadId };
    }
  };
}

/** First-party generic webhook channel, authored with the SDK's defineChannel. */
export const webhookChannelAtom = defineChannel({
  type: 'webhook',
  name: 'Webhook (generic HTTP)',
  capabilities: WEBHOOK_CAPABILITIES,
  envVars: [],
  create: createWebhookAdapter
});
