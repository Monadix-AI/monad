// Google Chat channel adapter — event webhook in, Chat API out (service-account auth). Async bot
// replies need an OAuth token minted from a service-account key (RS256 JWT → token exchange). Inbound
// events are authenticated via Google's public JWKS (RS256). Pure platform I/O; never touches sessions.
//
// secrets: serviceAccount = the service-account key JSON (string).
// options: { port?=8807, path?='/gchat', audience? (SA email, default: client_email from key JSON) }

import type { ChannelInbound } from '@monad/protocol';
import type { ChannelAdapter, ChannelCapabilities, ChannelContext, SentMessage } from '@monad/sdk-atom';

import { defineChannel } from '@monad/sdk-atom';
import { z } from 'zod';

import { serveHttpInbound } from './_http-inbound.ts';
import { verifyJwt } from './_jwt-verify.ts';

const GCHAT_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GCHAT_ISSUER = 'https://accounts.google.com';

const GCHAT_CAPABILITIES: ChannelCapabilities = {
  edit: false,
  typing: false,
  threads: false,
  maxMessageChars: 4096,
  markdown: true,
  reactions: false,
  nativeCommands: false,
  outboundMirror: true
};

const gchatEventSchema = z.looseObject({
  type: z.string().optional(),
  message: z
    .looseObject({
      text: z.string().optional(),
      name: z.string().optional(),
      sender: z.looseObject({ name: z.string().optional(), displayName: z.string().optional() }).optional()
    })
    .optional(),
  space: z.looseObject({ name: z.string().optional(), type: z.string().optional() }).optional(),
  user: z.looseObject({ name: z.string().optional() }).optional()
});
type GChatEvent = z.infer<typeof gchatEventSchema>;

/** Normalize a Google Chat MESSAGE event → ChannelInbound, or null. The chat is keyed by the space
 *  name (`spaces/AAA`). Exported for tests. */
export function normalizeGChatEvent(e: GChatEvent): ChannelInbound | null {
  if (e.type !== 'MESSAGE' || !e.space?.name) return null;
  const text = e.message?.text ?? '';
  const isCommand = text.startsWith('/');
  const [head, ...args] = isCommand ? text.trim().split(/\s+/) : [];
  return {
    chatId: e.space.name,
    userId: e.user?.name ?? e.message?.sender?.name ?? e.space.name,
    text,
    kind: isCommand ? 'command' : 'text',
    command: head ? head.slice(1).toLowerCase() : undefined,
    commandArgs: args,
    nativeMessageId: e.message?.name ?? `gc-${Date.now()}`,
    senderDisplay: e.message?.sender?.displayName,
    chatType: e.space.type === 'DM' ? 'dm' : 'group',
    isSelf: false,
    media: [],
    at: new Date().toISOString()
  };
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const serviceAccountSchema = z.looseObject({
  client_email: z.string(),
  private_key: z.string(),
  token_uri: z.string().optional()
});
type ServiceAccount = z.infer<typeof serviceAccountSchema>;

/** Mint a Google OAuth access token from a service-account key (RS256 self-signed JWT grant). */
async function mintToken(
  sa: ServiceAccount,
  scope: string,
  signal: AbortSignal
): Promise<{ token: string; exp: number }> {
  const tokenUri = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
  const iat = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = b64url(
    enc.encode(JSON.stringify({ iss: sa.client_email, scope, aud: tokenUri, iat, exp: iat + 3600 }))
  );
  const signingInput = `${header}.${claim}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(signingInput)));
  const jwt = `${signingInput}.${b64url(sig)}`;
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
    signal
  });
  const json = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!json.access_token) throw new Error(`gchat token failed: ${json.error_description ?? res.status}`);
  return { token: json.access_token, exp: Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000 };
}

export function createGoogleChatAdapter(ctx: ChannelContext): ChannelAdapter {
  const saRaw = ctx.secrets.serviceAccount ?? '';
  const port = Number(ctx.config.options.port) || 8807;
  const path = (typeof ctx.config.options.path === 'string' ? ctx.config.options.path : '/gchat') || '/gchat';
  // audience defaults to the service-account email from the key JSON; can be overridden via options.
  const audienceOpt = typeof ctx.config.options.audience === 'string' ? ctx.config.options.audience : '';

  let sa: ServiceAccount | undefined;
  let cached: { token: string; exp: number } | undefined;
  async function token(): Promise<string> {
    if (cached && cached.exp > Date.now()) return cached.token;
    if (!sa) sa = serviceAccountSchema.parse(JSON.parse(saRaw));
    cached = await mintToken(sa, 'https://www.googleapis.com/auth/chat.bot', ctx.signal);
    return cached.token;
  }

  function jwtAudience(): string {
    if (audienceOpt) return audienceOpt;
    if (!sa && saRaw) {
      try {
        sa = serviceAccountSchema.parse(JSON.parse(saRaw));
      } catch {
        /* parsed later */
      }
    }
    return sa?.client_email ?? '';
  }

  const server = serveHttpInbound(ctx, {
    port,
    path,
    verify: async (req) => {
      const aud = jwtAudience();
      if (!aud) return false; // no audience → can't validate the Google-signed JWT → fail closed
      const auth = req.headers.get('authorization') ?? '';
      const t = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!t) return false;
      try {
        await verifyJwt(t, { jwksUrl: GCHAT_JWKS_URL, issuer: GCHAT_ISSUER, audience: aud, signal: ctx.signal });
        return true;
      } catch {
        return false;
      }
    },
    handle: (raw) => {
      const ev = normalizeGChatEvent(gchatEventSchema.parse(JSON.parse(raw)));
      return { events: ev ? [ev] : [] };
    }
  });

  return {
    type: 'gchat',
    capabilities: GCHAT_CAPABILITIES,
    async connect() {
      if (!saRaw) throw new Error('gchat: secrets.serviceAccount (key JSON) is required');
      // The inbound JWT verifier needs an audience (options.audience or the key's client_email). If it
      // can't be derived, every webhook would 401 silently — surface it as a clear misconfig at connect
      // instead, so the verifier's fail-closed `return false` only ever guards a genuine runtime gap.
      if (!jwtAudience()) {
        throw new Error(
          'gchat: cannot derive JWT audience — set options.audience or provide a key JSON with client_email'
        );
      }
      server.start();
    },
    async disconnect() {
      server.stop();
    },
    async send(chatId: string, content: string): Promise<SentMessage> {
      const res = await fetch(`https://chat.googleapis.com/v1/${chatId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: content }),
        signal: ctx.signal
      });
      const json = (await res.json().catch(() => ({}))) as { name?: string };
      if (!res.ok) throw new Error(`gchat send failed: ${res.status}`);
      return { ref: json.name ?? `gc-${Date.now()}`, chatId };
    }
  };
}

export const googleChatChannelAtom = defineChannel({
  type: 'gchat',
  name: 'Google Chat',
  capabilities: GCHAT_CAPABILITIES,
  envVars: [{ name: 'GCHAT_SERVICE_ACCOUNT', description: 'Service-account key JSON', required: true, secret: true }],
  create: createGoogleChatAdapter
});
