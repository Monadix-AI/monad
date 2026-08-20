// End-to-end automated test of the daemon's MCP OAuth flow. No real browser, no external
// server: an in-process Bun.serve mock plays the authorization server, and the injected
// openBrowser plays the user-agent (follows the auth redirect into monad's real loopback
// callback). Exercises the REAL shipped path — discovery → DCR → loopback → token exchange
// → auth.json persistence → getHeader/Bearer.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IssuerMismatchError } from '@modelcontextprotocol/client';
import { createDefaultConfig, emptyAuth } from '@monad/environment';

import { authorizeMcpOAuth, createDaemonMcpOAuth } from '#/capabilities/mcp/oauth.ts';
import { stubConfigAccess } from '../../helpers.ts';

let dir: string;
let as: ReturnType<typeof Bun.serve>;
let origin: string;
let registeredApplicationType: string | undefined;
let authorizationResponseIssuer: string | undefined;
let authorizationResource: string | null = null;
let authorizationCodeChallenge: string | null = null;
let tokenResource: string | null = null;
let tokenCodeVerifier: string | null = null;
let tokenExchangeCount = 0;

function configFor() {
  const cfg = createDefaultConfig('OAuth Test');
  cfg.mcpServers.push({
    name: 'remote',
    transport: 'http',
    url: `${origin}/mcp`,
    auth: { mode: 'oauth', scopes: [], flow: 'loopback' },
    enabled: true,
    trust: { autoApproveTools: [], hostEscape: false }
  });
  return stubConfigAccess(cfg, emptyAuth());
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'monad-mcp-oauth-'));
  // Mock authorization server + protected-resource metadata.
  as = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const self = u.origin;
      switch (u.pathname) {
        case '/.well-known/oauth-protected-resource':
          return Response.json({ resource: `${self}/mcp`, authorization_servers: [self] });
        case '/.well-known/oauth-authorization-server':
          return Response.json({
            issuer: self,
            authorization_endpoint: `${self}/authorize`,
            token_endpoint: `${self}/token`,
            registration_endpoint: `${self}/register`,
            response_types_supported: ['code'],
            authorization_response_iss_parameter_supported: true
          });
        case '/register': {
          const reg = (await req.json()) as { application_type?: string; redirect_uris?: string[] };
          registeredApplicationType = reg.application_type;
          return Response.json({
            client_id: 'test-client',
            redirect_uris: reg.redirect_uris ?? [],
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code']
          });
        }
        case '/authorize': {
          // Stand in for user consent: redirect straight back to the loopback with a code.
          const redirectUri = u.searchParams.get('redirect_uri') ?? '';
          const state = u.searchParams.get('state') ?? '';
          authorizationResource = u.searchParams.get('resource');
          authorizationCodeChallenge = u.searchParams.get('code_challenge');
          const iss = authorizationResponseIssuer ?? self;
          const loc = `${redirectUri}?code=test-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(iss)}`;
          return new Response(null, { status: 302, headers: { location: loc } });
        }
        case '/token': {
          const tokenBody = new URLSearchParams(await req.text());
          tokenResource = tokenBody.get('resource');
          tokenCodeVerifier = tokenBody.get('code_verifier');
          tokenExchangeCount++;
          return Response.json({
            access_token: 'at-final',
            token_type: 'Bearer',
            refresh_token: 'rt',
            expires_in: 3600
          });
        }
        default:
          return new Response('not found', { status: 404 });
      }
    }
  });
  origin = `http://127.0.0.1:${as.port}`;
});

afterAll(async () => {
  as.stop(true);
  await rm(dir, { recursive: true, force: true });
});

test('full OAuth flow: onUnauthorized authorizes, persists, and getHeader yields a Bearer token', async () => {
  let authorizationState: string | null = null;
  let csrfVerifyCalls = 0;
  const originalVerify = Bun.CSRF.verify;
  Bun.CSRF.verify = ((token, options) => {
    csrfVerifyCalls++;
    expect(token).toBe(authorizationState as string);
    expect(typeof options?.secret).toBe('string');
    return originalVerify(token, options);
  }) as typeof Bun.CSRF.verify;
  const config = configFor();
  const auth = createDaemonMcpOAuth({
    serverName: 'remote',
    serverUrl: `${origin}/mcp`,
    config,
    interactive: true, // armed: a 401 may run the browser flow (explicit action / live tool-call)
    // The "browser": follow the authorize redirect into monad's loopback callback.
    openBrowser: (authUrl) => {
      authorizationState = new URL(authUrl).searchParams.get('state');
      void (async () => {
        const r = await fetch(authUrl, { redirect: 'manual' });
        const loc = r.headers.get('location');
        if (loc) await fetch(loc);
      })();
    }
  });

  try {
    // 1. No token yet → header is absent (would trigger the server 401).

    // 2. The 401 hook runs the interactive flow to completion.
    expect(await auth.onUnauthorized?.()).toBe(true);
    expect(csrfVerifyCalls).toBe(1);

    // 3. The access token is now supplied as a Bearer header…
    expect(await auth.getHeader()).toBe('Bearer at-final');

    // 4. …and persisted beside the MCP server (bound to the canonical resource).
    const server = config.get().cfg.mcpServers.find((candidate) => candidate.name === 'remote');
    const stored = server?.transport === 'http' ? server.oauth : undefined;
    expect(stored).toEqual({
      clientId: 'test-client',
      accessToken: 'at-final',
      refreshToken: 'rt',
      expiresAt: expect.any(Number),
      tokenEndpoint: `${origin}/token`,
      resource: `${origin}/mcp`,
      issuer: origin
    });
    expect(registeredApplicationType).toBe('native');
    expect({
      authorizationResource,
      hasCodeChallenge: Boolean(authorizationCodeChallenge),
      tokenResource,
      hasCodeVerifier: Boolean(tokenCodeVerifier)
    }).toEqual({
      authorizationResource: `${origin}/mcp`,
      hasCodeChallenge: true,
      tokenResource: `${origin}/mcp`,
      hasCodeVerifier: true
    });
  } finally {
    Bun.CSRF.verify = originalVerify;
  }
});

test('OAuth callback issuer mismatch is rejected before token exchange', async () => {
  const exchangesBefore = tokenExchangeCount;
  authorizationResponseIssuer = `${origin}/unexpected-issuer`;
  try {
    await expect(
      authorizeMcpOAuth({
        serverName: 'remote',
        serverUrl: `${origin}/mcp`,
        config: configFor(),
        openBrowser: (authUrl) => {
          void (async () => {
            const response = await fetch(authUrl, { redirect: 'manual' });
            const location = response.headers.get('location');
            if (location) await fetch(location);
          })().catch(() => {});
        }
      })
    ).rejects.toBeInstanceOf(IssuerMismatchError);
    expect(tokenExchangeCount).toBe(exchangesBefore);
  } finally {
    authorizationResponseIssuer = undefined;
  }
});

test('un-armed auth never opens the browser on a 401; arm() enables it', async () => {
  let browserOpens = 0;
  const config = configFor();
  const auth = createDaemonMcpOAuth({
    serverName: 'remote',
    serverUrl: `${origin}/mcp`,
    config,
    // interactive defaults to false — this is a boot/diff-reload connect.
    openBrowser: (authUrl) => {
      browserOpens++;
      void (async () => {
        const r = await fetch(authUrl, { redirect: 'manual' });
        const loc = r.headers.get('location');
        if (loc) await fetch(loc);
      })();
    }
  });

  // Un-armed + no stored token → 401 hook fails closed without opening a browser.
  expect(await auth.onUnauthorized?.()).toBe(false);
  expect(browserOpens).toBe(0);

  // Once armed (connection is live → a later agent tool-call 401), it runs the browser flow.
  (auth as { arm: () => void }).arm();
  expect(await auth.onUnauthorized?.()).toBe(true);
  expect(browserOpens).toBe(1);
  const server = config.get().cfg.mcpServers.find((candidate) => candidate.name === 'remote');
  expect(server?.transport === 'http' ? server.oauth?.accessToken : undefined).toBe('at-final');
});
