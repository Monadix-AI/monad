// Microsoft Teams channel adapter — Bot Framework activity webhook in, Connector API out (AAD
// client-credentials token). The Connector reply target (serviceUrl) is per-activity, so we remember
// it per conversation. Inbound activities are authenticated via Bot Framework JWKS (RS256). Pure
// platform I/O.
//
// secrets: extra.appId, extra.appPassword (AAD app). options: { port?=8806, path?='/teams', tenantId? }

import type { ChannelInbound } from '@monad/protocol';
import type { ChannelAdapter, ChannelCapabilities, ChannelContext, SentMessage } from '@monad/sdk-atom';
import type { Activity } from 'botframework-schema';

import { defineChannel } from '@monad/sdk-atom';
import { z } from 'zod';

import { serveHttpInbound } from './_http-inbound.ts';
import { verifyJwt } from './_jwt-verify.ts';

const TEAMS_JWKS_URL = 'https://login.botframework.com/v1/.well-known/keys';
const TEAMS_ISSUER = 'https://api.botframework.com';

const TEAMS_CAPABILITIES: ChannelCapabilities = {
  edit: false,
  typing: false,
  threads: false,
  maxMessageChars: 28_000,
  markdown: true,
  reactions: false,
  nativeCommands: false,
  outboundMirror: true
};

const teamsActivitySchema = z.looseObject({
  type: z.string().optional(),
  id: z.string().optional(),
  text: z.string().optional(),
  serviceUrl: z.string().optional(),
  from: z.looseObject({ id: z.string().optional(), name: z.string().optional() }).optional(),
  recipient: z.looseObject({ id: z.string().optional() }).optional(),
  conversation: z.looseObject({ id: z.string().optional(), conversationType: z.string().optional() }).optional(),
  entities: z
    .array(
      z.looseObject({ type: z.string().optional(), mentioned: z.looseObject({ id: z.string().optional() }).optional() })
    )
    .optional()
});
type TeamsActivity = z.infer<typeof teamsActivitySchema>;

/** Normalize a Bot Framework message activity → ChannelInbound, or null. `mentionedSelf` is true when
 *  an entity mentions the bot (recipient.id). Exported for tests. */
export function normalizeTeamsActivity(a: TeamsActivity): ChannelInbound | null {
  if (a.type !== 'message' || !a.conversation?.id) return null;
  const text = (a.text ?? '').trim();
  const isCommand = text.startsWith('/');
  const [head, ...args] = isCommand ? text.trim().split(/\s+/) : [];
  const mentionedSelf = (a.entities ?? []).some((e) => e.type === 'mention' && e.mentioned?.id === a.recipient?.id);
  return {
    chatId: a.conversation.id,
    userId: a.from?.id ?? a.conversation.id,
    text,
    kind: isCommand ? 'command' : 'text',
    command: head ? head.slice(1).toLowerCase() : undefined,
    commandArgs: args,
    nativeMessageId: a.id ?? `tm-${Date.now()}`,
    senderDisplay: a.from?.name,
    chatType: a.conversation.conversationType === 'personal' ? 'dm' : 'group',
    mentionedSelf,
    isSelf: false,
    media: [],
    at: new Date().toISOString()
  };
}

/** Whether a Bot Framework serviceUrl host is one we'll send tokens to (Connector endpoints only). */
export function isAllowedTeamsServiceUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'smba.trafficmanager.net' || h.endsWith('.botframework.com') || h.endsWith('.trafficmanager.net');
  } catch {
    return false;
  }
}

export function createTeamsAdapter(ctx: ChannelContext): ChannelAdapter {
  const appId = ctx.secrets.appId ?? '';
  const appPassword = ctx.secrets.appPassword ?? ctx.secrets.token ?? '';
  const tenantId = typeof ctx.config.options.tenantId === 'string' ? ctx.config.options.tenantId : 'botframework.com';
  const port = Number(ctx.config.options.port) || 8806;
  const path = (typeof ctx.config.options.path === 'string' ? ctx.config.options.path : '/teams') || '/teams';

  // The Connector base URL to reply to, learned per conversation from inbound activities.
  const serviceUrls = new Map<string, string>();
  let cached: { token: string; exp: number } | undefined;
  async function aadToken(): Promise<string> {
    if (cached && cached.exp > Date.now()) return cached.token;
    const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: appId,
        client_secret: appPassword,
        scope: 'https://api.botframework.com/.default'
      }).toString(),
      signal: ctx.signal
    });
    const json = z
      .object({
        access_token: z.string().optional(),
        expires_in: z.number().optional(),
        error_description: z.string().optional()
      })
      .parse(await res.json());
    if (!json.access_token) throw new Error(`teams token failed: ${json.error_description ?? res.status}`);
    cached = { token: json.access_token, exp: Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000 };
    return cached.token;
  }

  const server = serveHttpInbound(ctx, {
    port,
    path,
    verify: async (req) => {
      if (!appId) return false; // no appId → can't validate the Bot Framework JWT → fail closed
      const auth = req.headers.get('authorization') ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token) return false;
      try {
        await verifyJwt(token, { jwksUrl: TEAMS_JWKS_URL, issuer: TEAMS_ISSUER, audience: appId, signal: ctx.signal });
        return true;
      } catch {
        return false;
      }
    },
    handle: (raw) => {
      const a = teamsActivitySchema.parse(JSON.parse(raw));
      // JWT validation above ensures the activity is genuinely from Bot Framework; still restrict
      // serviceUrl to the official allowlist as a defence-in-depth against unexpected token flows.
      if (a.conversation?.id && a.serviceUrl && isAllowedTeamsServiceUrl(a.serviceUrl)) {
        serviceUrls.set(a.conversation.id, a.serviceUrl.replace(/\/+$/, ''));
      }
      const ev = normalizeTeamsActivity(a);
      return { events: ev ? [ev] : [] };
    }
  });

  return {
    type: 'teams',
    capabilities: TEAMS_CAPABILITIES,
    async connect() {
      if (!appId || !appPassword) throw new Error('teams: extra.appId and extra.appPassword are required');
      server.start();
    },
    async disconnect() {
      server.stop();
    },
    async send(chatId: string, content: string): Promise<SentMessage> {
      const serviceUrl = serviceUrls.get(chatId);
      if (!serviceUrl)
        throw new Error(`teams: no serviceUrl known for conversation ${chatId} (reply only after an inbound)`);
      const token = await aadToken();
      const res = await fetch(`${serviceUrl}/v3/conversations/${encodeURIComponent(chatId)}/activities`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'message', text: content } satisfies Pick<Activity, 'type' | 'text'>),
        signal: ctx.signal
      });
      const json = z.object({ id: z.string().optional() }).parse(await res.json().catch(() => ({})));
      if (!res.ok) throw new Error(`teams send failed: ${res.status}`);
      return { ref: json.id ?? `tm-${Date.now()}`, chatId };
    }
  };
}

export const teamsChannelAtom = defineChannel({
  type: 'teams',
  name: 'Microsoft Teams',
  capabilities: TEAMS_CAPABILITIES,
  envVars: [
    { name: 'TEAMS_APP_ID', description: 'Bot AAD app id', required: true, secret: true },
    { name: 'TEAMS_APP_PASSWORD', description: 'Bot AAD app password', required: true, secret: true }
  ],
  create: createTeamsAdapter
});
