// Shared inbound-HTTP plumbing for webhook-style channels (LINE, WhatsApp, Teams, Google Chat,
// Feishu, WeCom, BlueBubbles/iMessage, …). Each such adapter LISTENS on its own port: this helper
// owns the Bun.serve listener, GET URL-verification challenges, raw-body signature checks, and
// fan-out to ctx.onMessage. The adapter supplies the platform-specific verify/parse + its own
// outbound send(). Pure platform I/O — never touches sessions.

import type { ChannelInbound } from '@monad/protocol';
import type { ChannelContext } from '@monad/sdk-atom';

export interface HttpInboundConfig {
  port: number;
  path: string;
  /** Optional GET handler for platform URL-verification (e.g. WhatsApp hub.challenge). Returning a
   *  Response short-circuits; otherwise GET returns 200 "ok". */
  onGet?: (url: URL) => Response | undefined;
  /** Authenticate the request from its raw body (signature/secret). Return false → 401. */
  verify?: (req: Request, rawBody: string) => boolean | Promise<boolean>;
  /** Opt out of requiring `verify`. Only for adapters whose payloads are genuinely unsignable AND whose
   *  endpoint is otherwise gated (e.g. a loopback-only local bridge). Must be set deliberately — without
   *  it, a listener with no `verify` refuses to start rather than accepting spoofable unsigned requests. */
  allowUnverified?: boolean;
  /** Parse an inbound POST body into 0+ normalized events. Return `response` to override the 200 ack
   *  (e.g. Feishu's url_verification challenge echo). Throwing yields a 400. */
  handle: (rawBody: string, req: Request) => { events?: ChannelInbound[]; response?: Response };
}

export interface HttpInboundServer {
  start(): void;
  stop(): void;
}

export function serveHttpInbound(ctx: ChannelContext, cfg: HttpInboundConfig): HttpInboundServer {
  let server: ReturnType<typeof Bun.serve> | undefined;
  return {
    start() {
      // Fail closed: a webhook listener with no signature verifier accepts any unsigned POST, and the
      // request body asserts the sender identity that the channel allowlist then trusts — so an
      // unverified listener is an authz bypass, not just a missing nicety. Require an explicit opt-out.
      if (!cfg.verify && !cfg.allowUnverified) {
        throw new Error(
          `refusing to start unauthenticated webhook listener on :${cfg.port}${cfg.path} — configure the signature secret`
        );
      }
      server = Bun.serve({
        port: cfg.port,
        // An unverified listener (allowUnverified, e.g. the local BlueBubbles bridge with no signing
        // secret) must bind loopback only — otherwise an unsigned, spoofable endpoint is exposed to the
        // whole LAN. A verified listener binds all interfaces so the platform's webhook can reach it.
        ...(cfg.verify ? {} : { hostname: '127.0.0.1' }),
        fetch: async (req) => {
          const url = new URL(req.url);
          if (req.method === 'GET') return cfg.onGet?.(url) ?? new Response('ok');
          if (req.method !== 'POST' || url.pathname !== cfg.path) return new Response('not found', { status: 404 });
          const raw = await req.text();
          if (cfg.verify && !(await cfg.verify(req, raw))) return new Response('unauthorized', { status: 401 });
          let result: { events?: ChannelInbound[]; response?: Response };
          try {
            result = cfg.handle(raw, req);
          } catch (err) {
            ctx.log('warn', `inbound parse failed: ${err instanceof Error ? err.message : String(err)}`);
            return new Response('bad payload', { status: 400 });
          }
          for (const ev of result.events ?? []) ctx.onMessage(ev);
          return result.response ?? new Response(null, { status: 200 });
        }
      });
      ctx.log('info', `listening on :${cfg.port}${cfg.path}`);
    },
    stop() {
      server?.stop(true);
      server = undefined;
    }
  };
}

/** HMAC-SHA256 hex of `body` keyed by `secret` — the signature scheme most webhook platforms use.
 *  Comparison should be constant-time; callers compare against the platform's header. */
export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** HMAC-SHA256 of `body` as base64 (LINE / Twilio style). */
export async function hmacSha256Base64(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/** HMAC-SHA1 of `body` as base64 (Twilio's X-Twilio-Signature scheme). */
export async function hmacSha1Base64(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/** Constant-time string compare. XORs lengths so length mismatch doesn't short-circuit;
 *  iterates max(a,b) chars to avoid leaking which string is longer via timing. */
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (i < a.length ? a.charCodeAt(i) : 0) ^ (i < b.length ? b.charCodeAt(i) : 0);
  }
  return diff === 0;
}
