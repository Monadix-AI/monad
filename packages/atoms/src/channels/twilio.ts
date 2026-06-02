// Twilio channel adapter — SMS / WhatsApp via Twilio. Inbound is a form-encoded webhook signed with
// X-Twilio-Signature (base64 HMAC-SHA1 over the request URL + sorted POST params, keyed by the auth
// token). Outbound is the Messages REST API with HTTP Basic auth. Pure platform I/O.
//
// secrets: token = auth token (signature + Basic auth password); extra.accountSid = Basic auth user.
// options: { from, port?=8803, path?='/twilio' }  — `from` is your Twilio number ("+1…" or "whatsapp:+1…").

import type { ChannelInbound } from '@monad/protocol';
import type { ChannelAdapter, ChannelCapabilities, ChannelContext, SentMessage } from '@monad/sdk-atom';

import { defineChannel } from '@monad/sdk-atom';

import { hmacSha1Base64, serveHttpInbound, timingSafeEqual } from './_http-inbound.ts';

const TWILIO_CAPABILITIES: ChannelCapabilities = {
  edit: false,
  typing: false,
  threads: false,
  maxMessageChars: 1600,
  markdown: false,
  reactions: false,
  nativeCommands: false,
  outboundMirror: true
};

/** Normalize Twilio's form-encoded inbound (From/To/Body/MessageSid) → ChannelInbound. The sender's
 *  address is both the user and the chat (1:1). Exported for tests. */
export function normalizeTwilioForm(params: URLSearchParams): ChannelInbound | null {
  const from = params.get('From');
  if (!from) return null;
  const text = params.get('Body') ?? '';
  const isCommand = text.startsWith('/');
  const [head, ...args] = isCommand ? text.trim().split(/\s+/) : [];
  return {
    chatId: from,
    userId: from,
    text,
    kind: isCommand ? 'command' : text ? 'text' : 'media',
    command: head ? head.slice(1).toLowerCase() : undefined,
    commandArgs: args,
    nativeMessageId: params.get('MessageSid') ?? `tw-${Date.now()}`,
    chatType: 'dm',
    isSelf: false,
    media: [],
    at: new Date().toISOString()
  };
}

/** Recompute Twilio's expected signature: base64 HMAC-SHA1 over (url + each sorted param key+value). */
export async function twilioSignature(authToken: string, url: string, params: URLSearchParams): Promise<string> {
  const keys = [...new Set([...params.keys()])].sort();
  let data = url;
  for (const k of keys) data += k + (params.get(k) ?? '');
  return hmacSha1Base64(authToken, data);
}

export function createTwilioAdapter(ctx: ChannelContext): ChannelAdapter {
  const authToken = ctx.secrets.token;
  const accountSid = ctx.secrets.accountSid ?? '';
  const from = String(ctx.config.options.from ?? '');
  const port = Number(ctx.config.options.port) || 8803;
  const path = (typeof ctx.config.options.path === 'string' ? ctx.config.options.path : '/twilio') || '/twilio';

  const server = serveHttpInbound(ctx, {
    port,
    path,
    verify: authToken
      ? async (req, raw) => {
          const header = req.headers.get('x-twilio-signature') ?? '';
          const expected = await twilioSignature(authToken, req.url, new URLSearchParams(raw));
          return timingSafeEqual(header, expected);
        }
      : undefined,
    handle: (raw) => {
      const ev = normalizeTwilioForm(new URLSearchParams(raw));
      return {
        events: ev ? [ev] : [],
        response: new Response('<Response></Response>', { headers: { 'content-type': 'text/xml' } })
      };
    }
  });

  return {
    type: 'twilio',
    capabilities: TWILIO_CAPABILITIES,
    async connect() {
      if (!accountSid || !from) throw new Error('twilio: extra.accountSid and options.from are required');
      // authToken gates BOTH outbound (Basic auth) and the inbound X-Twilio-Signature check, so it is
      // required for the channel to function at all — fail closed rather than starting an unsigned listener.
      if (!authToken) throw new Error('twilio: secrets.token (auth token) is required');
      server.start();
    },
    async disconnect() {
      server.stop();
    },
    async send(chatId: string, content: string): Promise<SentMessage> {
      const auth = btoa(`${accountSid}:${authToken}`);
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: 'POST',
        headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: chatId, From: from, Body: content }).toString(),
        signal: ctx.signal
      });
      const json = (await res.json().catch(() => ({}))) as { sid?: string };
      if (!res.ok) throw new Error(`twilio send failed: ${res.status}`);
      return { ref: json.sid ?? `tw-${Date.now()}`, chatId };
    }
  };
}

export const twilioChannelAtom = defineChannel({
  type: 'twilio',
  name: 'Twilio (SMS/WhatsApp)',
  capabilities: TWILIO_CAPABILITIES,
  envVars: [{ name: 'TWILIO_AUTH_TOKEN', description: 'Twilio auth token', required: true, secret: true }],
  create: createTwilioAdapter
});
