// End-to-end automated test of the daemon's MCP OAuth flow. No real browser, no external
// server: an in-process Bun.serve mock plays the authorization server, and the injected
// openBrowser plays the user-agent (follows the auth redirect into monad's real loopback
// callback). Exercises the REAL shipped path — discovery → DCR → loopback → token exchange
// → auth.json persistence → getHeader/Bearer.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAuth, saveAuth } from '@monad/home';

import { createDaemonMcpOAuth } from '@/capabilities/mcp/oauth.ts';

let dir: string;
let authPath: string;
let as: ReturnType<typeof Bun.serve>;
let origin: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'monad-mcp-oauth-'));
  authPath = join(dir, 'auth.json');
  // Minimal valid auth.json so the token store can persist into it.
  await saveAuth(authPath, {
    version: 1,
    activeProvider: null,
    updatedAt: new Date().toISOString(),
    credentialPool: {}
  });

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
            response_types_supported: ['code']
          });
        case '/register': {
          const reg = (await req.json()) as { redirect_uris?: string[] };
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
          const loc = `${redirectUri}?code=test-code&state=${encodeURIComponent(state)}`;
          return new Response(null, { status: 302, headers: { location: loc } });
        }
        case '/token':
          return Response.json({
            access_token: 'at-final',
            token_type: 'Bearer',
            refresh_token: 'rt',
            expires_in: 3600
          });
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
  const auth = createDaemonMcpOAuth({
    serverName: 'remote',
    serverUrl: `${origin}/mcp`,
    authPath,
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

    // 4. …and persisted in auth.json (bound to the canonical resource).
    const stored = (await loadAuth(authPath))?.mcpOAuth?.remote;
    expect(stored?.accessToken).toBe('at-final');
    expect(stored?.refreshToken).toBe('rt');
    expect(stored?.resource).toBe(`${origin}/mcp`);
    expect(stored?.clientId).toBe('test-client');
  } finally {
    Bun.CSRF.verify = originalVerify;
  }
});

test('un-armed auth never opens the browser on a 401; arm() enables it', async () => {
  const authPath2 = join(dir, 'auth2.json');
  await saveAuth(authPath2, {
    version: 1,
    activeProvider: null,
    updatedAt: new Date().toISOString(),
    credentialPool: {}
  });

  let browserOpens = 0;
  const auth = createDaemonMcpOAuth({
    serverName: 'remote',
    serverUrl: `${origin}/mcp`,
    authPath: authPath2,
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
  expect((await loadAuth(authPath2))?.mcpOAuth?.remote?.accessToken).toBe('at-final');
});
