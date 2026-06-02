// Daemon glue for MCP server OAuth. The interactive (loopback) flow runs on the official MCP SDK's
// `auth()` orchestrator + `OAuthClientProvider` (standard RFC 9728/8414/7591/PKCE implementation);
// this file supplies the daemon-side seams — a loopback callback server, the OS browser opener, and
// token/client persistence in auth.json. The device flow (RFC 8628, for headless daemons) is NOT
// covered by the SDK, so it stays on @/capabilities/tools primitives.
//
// Trigger policy (createDaemonMcpOAuth): a 401 only opens the browser when the auth is "armed".
// Connect handshakes start UN-armed, so booting/diff-reloading a server never pops a browser — it
// silently refreshes a stored token or fails closed. `arm()` is called once the connection is live,
// so a later agent tool-call that 401s (token expired/revoked mid-session) DOES re-authorize. The
// explicit Authorize/reconnect actions construct the auth already armed.
//
// NOTE: the interactive path (loopback + browser) can't be exercised by a real browser in unit
// tests; test/unit/mcp-oauth.test.ts drives the whole flow with an in-process mock AS + an injected
// openBrowser that follows the redirect into the real loopback callback.

import type {
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { LocalePack } from '@monad/i18n';

import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import { loadAuth, openUrl, saveAuth } from '@monad/home';
import { createI18n } from '@monad/i18n';
import { enMessages, zhMessages } from '@monad/i18n/messages';

import {
  canonicalResourceUri,
  defaultResourceMetadataUrl,
  discoverAuthServer,
  discoverProtectedResource,
  type McpHttpAuth,
  McpOAuthError,
  pollDeviceToken,
  type StoredOAuth,
  startDeviceAuthorization
} from '@/capabilities/tools';

const AUTHORIZE_TIMEOUT_MS = 5 * 60_000;
const OAUTH_CSRF_SECRET = crypto.randomUUID();
const CALLBACK_LOCALE_PACKS: LocalePack[] = [
  { locale: 'en', name: 'English', messages: enMessages },
  { locale: 'zh', name: '简体中文', messages: zhMessages }
];

function callbackT(req: Request) {
  const acceptLanguage = req.headers.get('accept-language') ?? '';
  const locale = /^zh\b/i.test(acceptLanguage) ? 'zh' : 'en';
  return createI18n({ locale, packs: CALLBACK_LOCALE_PACKS }).t;
}

export interface McpOAuthOptions {
  serverName: string;
  serverUrl: string;
  authPath: string;
  /** Preconfigured client id (skips Dynamic Client Registration). */
  clientId?: string;
  scopes?: string[];
  /** 'loopback' (browser + localhost redirect) or 'device' (RFC 8628). Default loopback. */
  flow?: 'loopback' | 'device';
  /** Start armed — i.e. a 401 may open the browser immediately. Connect handshakes pass false (boot/
   *  diff-reload must never pop a browser); the explicit Authorize/reconnect actions pass true. */
  interactive?: boolean;
  /** Override for tests/headless; defaults to the OS browser opener. */
  openBrowser?: (url: string) => void;
  log?: (msg: string) => void;
}

/** An McpHttpAuth whose 401 handling is gated by an `arm()` latch — see the trigger policy above. */
export type DaemonMcpAuth = McpHttpAuth & { arm: () => void };

/** Build the McpHttpAuth for an http MCP server. getHeader serves the stored access token; a 401
 *  first tries a silent refresh (no browser), then — only when armed — runs the interactive flow. */
export function createDaemonMcpOAuth(opts: McpOAuthOptions): DaemonMcpAuth {
  let armed = opts.interactive ?? false;
  return {
    async getHeader() {
      const stored = await loadToken(opts.authPath, opts.serverName);
      return stored?.accessToken ? `Bearer ${stored.accessToken}` : undefined;
    },
    async onUnauthorized() {
      // A stored refresh_token can recover silently — always worth a try, even un-armed (boot).
      if (await refreshSilently(opts)) return true;
      // No silent recovery. Only escalate to the user (browser / device code) when armed: an
      // explicit action or a live agent tool-call — never a boot/diff-reload handshake.
      if (!armed) return false;
      await runInteractiveFlow(opts);
      return true;
    },
    arm() {
      armed = true;
    }
  };
}

/** Run the OAuth flow on demand (UI/CLI "Authorize" action) and persist the tokens, so a later
 *  connect picks them up. Always interactive. Throws on failure/timeout. */
export async function authorizeMcpOAuth(opts: McpOAuthOptions): Promise<void> {
  await runInteractiveFlow(opts);
}

function runInteractiveFlow(opts: McpOAuthOptions): Promise<void> {
  if (opts.flow === 'device') {
    return authorizeDevice(opts).then((tokens) => saveToken(opts.authPath, opts.serverName, tokens));
  }
  return authorizeInteractive(opts);
}

async function loadToken(authPath: string, name: string): Promise<StoredOAuth | null> {
  const auth = await loadAuth(authPath);
  return auth?.mcpOAuth?.[name] ?? null;
}

async function saveToken(authPath: string, name: string, tokens: StoredOAuth): Promise<void> {
  const auth = await loadAuth(authPath);
  if (!auth) throw new McpOAuthError('auth.json missing — cannot persist MCP OAuth tokens');
  auth.mcpOAuth = { ...(auth.mcpOAuth ?? {}), [name]: tokens };
  auth.updatedAt = new Date().toISOString();
  await saveAuth(authPath, auth);
}

/** Attempt a no-browser token refresh via the SDK. Returns true only if a fresh token was obtained
 *  and persisted; never opens a browser (the provider's redirect is a no-op here). */
async function refreshSilently(opts: McpOAuthOptions): Promise<boolean> {
  const stored = await loadToken(opts.authPath, opts.serverName);
  if (!stored?.refreshToken) return false; // nothing to refresh with → needs interactive authz
  const clientRef: ClientRef = { id: opts.clientId ?? stored.clientId };
  // redirect_uri is required metadata but unused on the refresh path; a placeholder loopback is fine.
  const provider = createProvider(opts, 'http://127.0.0.1:0/callback', '', clientRef, true);
  try {
    return (await auth(provider, { serverUrl: opts.serverUrl })) === 'AUTHORIZED';
  } catch {
    return false;
  }
}

/** Mutable client_id shared across the two `auth()` calls (and retries) of one interactive flow.
 *  Kept in memory because auth.json's record is all-or-nothing — a client_id can't be persisted
 *  before the token it ships with. Seeded from a preconfigured or previously-stored id. */
interface ClientRef {
  id?: string;
}

/**
 * Interactive authorization-code + PKCE flow via the SDK's `auth()` orchestrator. We bind a
 * loopback callback server, hand the SDK a provider that persists into auth.json, and let it do
 * discovery → DCR → authorize-redirect. The first `auth()` returns 'REDIRECT' (browser opened);
 * after the loopback captures the code, a second `auth()` exchanges it for tokens (or the first
 * returns 'AUTHORIZED' when an existing refresh_token covers it, no browser). A stored client_id the
 * server has since forgotten (DCR clients can be GC'd) surfaces as `invalid_client` on the redirect —
 * per the MCP spec we drop it and re-register once.
 */
async function authorizeInteractive(opts: McpOAuthOptions): Promise<void> {
  const persisted = await loadToken(opts.authPath, opts.serverName);
  const clientRef: ClientRef = { id: opts.clientId ?? persisted?.clientId };

  for (let attempt = 0; attempt < 2; attempt++) {
    const state = Bun.CSRF.generate(OAUTH_CSRF_SECRET, { expiresIn: AUTHORIZE_TIMEOUT_MS });
    const loopback = startLoopback(state);
    try {
      const redirectUri = `http://127.0.0.1:${loopback.port}/callback`;
      const provider = createProvider(opts, redirectUri, state, clientRef, false);

      const result = await auth(provider, { serverUrl: opts.serverUrl });
      if (result === 'REDIRECT') {
        const code = await loopback.code; // resolves on the callback (state-validated)
        await auth(provider, { serverUrl: opts.serverUrl, authorizationCode: code });
      }
      return;
    } catch (err) {
      if (attempt === 0 && err instanceof McpOAuthError && err.message.includes('invalid_client') && !opts.clientId) {
        clientRef.id = undefined; // forget the rejected client and register a fresh one
        opts.log?.(`MCP "${opts.serverName}" client_id rejected — re-registering and retrying...`);
        continue;
      }
      throw err;
    } finally {
      loopback.stop();
    }
  }
  throw new McpOAuthError(`"${opts.serverName}" client registration repeatedly invalid`);
}

/** An OAuthClientProvider backed by the daemon's loopback + browser, persisting completed tokens
 *  (with their client_id) into auth.json. The client_id lives in `clientRef` until a token ships;
 *  discovery's token_endpoint and the PKCE verifier are held in-process for this flow only. When
 *  `silent`, the authorization redirect is suppressed (used by the no-browser refresh path). */
function createProvider(
  opts: McpOAuthOptions,
  redirectUri: string,
  state: string,
  clientRef: ClientRef,
  silent: boolean
): OAuthClientProvider {
  const resource = canonicalResourceUri(opts.serverUrl);
  let codeVerifier = '';
  let tokenEndpoint = '';

  const metadata: OAuthClientMetadata = {
    client_name: 'monad',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none', // public client; auth is via PKCE
    ...(opts.scopes?.length ? { scope: opts.scopes.join(' ') } : {})
  };

  return {
    get redirectUrl() {
      return redirectUri;
    },
    get clientMetadata() {
      return metadata;
    },
    state: () => state,
    clientInformation() {
      return clientRef.id ? { client_id: clientRef.id } : undefined;
    },
    saveClientInformation(info: OAuthClientInformation) {
      clientRef.id = info.client_id;
    },
    async tokens() {
      const s = await loadToken(opts.authPath, opts.serverName);
      if (!s?.accessToken) return undefined;
      return {
        access_token: s.accessToken,
        token_type: 'Bearer',
        ...(s.refreshToken ? { refresh_token: s.refreshToken } : {})
      };
    },
    async saveTokens(tokens: OAuthTokens) {
      await saveToken(opts.authPath, opts.serverName, {
        clientId: clientRef.id,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
        tokenEndpoint,
        resource
      });
    },
    redirectToAuthorization(url: URL) {
      if (silent) return; // refresh path: never open a browser
      (opts.openBrowser ?? openUrl)(url.toString());
      opts.log?.(`MCP "${opts.serverName}" requires authorization — complete it in the browser:\n  ${url.toString()}`);
    },
    saveCodeVerifier(v: string) {
      codeVerifier = v;
    },
    codeVerifier() {
      return codeVerifier;
    },
    saveDiscoveryState(s: OAuthDiscoveryState) {
      const te = s.authorizationServerMetadata?.token_endpoint;
      if (typeof te === 'string') tokenEndpoint = te;
    }
  };
}

// Device Authorization Grant (RFC 8628) — for headless/remote daemons where a loopback redirect is
// unreachable. The MCP SDK does not implement device flow, so this stays on @/capabilities/tools primitives.
async function authorizeDevice(opts: McpOAuthOptions): Promise<StoredOAuth> {
  const resource = canonicalResourceUri(opts.serverUrl);
  const { authorizationServers } = await discoverProtectedResource(defaultResourceMetadataUrl(opts.serverUrl));
  const issuer = authorizationServers[0];
  if (!issuer) throw new McpOAuthError(`no authorization server advertised for ${opts.serverName}`);
  const meta = await discoverAuthServer(issuer);
  if (!meta.deviceAuthorizationEndpoint) {
    throw new McpOAuthError(`"${opts.serverName}" authorization server has no device_authorization_endpoint`);
  }
  // Device flow needs a registered public client; require a preconfigured clientId (the
  // common headless setup) rather than relying on DCR.
  const clientId = opts.clientId;
  if (!clientId) throw new McpOAuthError(`device flow for "${opts.serverName}" requires a preconfigured clientId`);

  const device = await startDeviceAuthorization({
    deviceAuthorizationEndpoint: meta.deviceAuthorizationEndpoint,
    clientId,
    resource,
    scopes: opts.scopes
  });
  const where = device.verificationUriComplete ?? `${device.verificationUri} and enter code ${device.userCode}`;
  opts.log?.(`MCP "${opts.serverName}" requires authorization — on any device open: ${where}`);

  const tokens = await pollDeviceToken({
    tokenEndpoint: meta.tokenEndpoint,
    deviceCode: device.deviceCode,
    clientId,
    resource,
    interval: device.interval,
    expiresAt: device.expiresAt
  });
  return {
    clientId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    tokenEndpoint: meta.tokenEndpoint,
    resource
  };
}

interface Loopback {
  port: number;
  code: Promise<string>;
  stop: () => void;
}

function startLoopback(expectedState: string): Loopback {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const timer = setTimeout(() => rejectCode(new McpOAuthError('authorization timed out')), AUTHORIZE_TIMEOUT_MS);

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const t = callbackT(req);
      const u = new URL(req.url);
      if (u.pathname !== '/callback') return new Response(t('web.oauth.notFound'), { status: 404 });
      const error = u.searchParams.get('error');
      if (error) {
        clearTimeout(timer);
        rejectCode(new McpOAuthError(`authorization denied: ${error}`));
        return new Response(t('web.oauth.failed'), { status: 400 });
      }
      const returnedCode = u.searchParams.get('code');
      const returnedState = u.searchParams.get('state');
      if (
        !returnedCode ||
        !returnedState ||
        returnedState !== expectedState ||
        !Bun.CSRF.verify(returnedState, { secret: OAUTH_CSRF_SECRET, maxAge: AUTHORIZE_TIMEOUT_MS })
      ) {
        // state mismatch → possible CSRF; do not resolve.
        return new Response(t('web.oauth.invalid'), { status: 400 });
      }
      clearTimeout(timer);
      resolveCode(returnedCode);
      return new Response(`<h3>${t('web.oauth.completeTitle')}</h3><p>${t('web.oauth.completeBody')}</p>`, {
        headers: { 'content-type': 'text/html' }
      });
    }
  });

  const port = server.port;
  if (port === undefined) {
    server.stop(true);
    clearTimeout(timer);
    throw new McpOAuthError('loopback callback server failed to bind a port');
  }
  return {
    port,
    code,
    stop: () => {
      clearTimeout(timer);
      server.stop(true);
    }
  };
}
