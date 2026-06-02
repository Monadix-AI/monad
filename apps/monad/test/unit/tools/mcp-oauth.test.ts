import { expect, test } from 'bun:test';

import {
  canonicalResourceUri,
  defaultResourceMetadataUrl,
  discoverAuthServer,
  discoverProtectedResource,
  pollDeviceToken,
  startDeviceAuthorization
} from '#/capabilities/tools';

// These primitives back the device-grant flow (RFC 8628), the one path the MCP SDK does not cover.
// The interactive authorization-code + PKCE + DCR flow runs on the SDK and is exercised end-to-end
// in apps/monad/test/unit/mcp-oauth.test.ts.

// ── canonical resource URI (RFC 8707) ────────────────────────────────────────

test('canonicalResourceUri normalizes per the MCP spec examples', () => {
  expect(canonicalResourceUri('https://mcp.example.com/mcp')).toBe('https://mcp.example.com/mcp');
  expect(canonicalResourceUri('https://mcp.example.com')).toBe('https://mcp.example.com');
  expect(canonicalResourceUri('https://mcp.example.com:8443')).toBe('https://mcp.example.com:8443');
  expect(canonicalResourceUri('https://MCP.Example.com/')).toBe('https://mcp.example.com'); // lowercase host + drop trailing slash
  expect(canonicalResourceUri('https://mcp.example.com/mcp#frag')).toBe('https://mcp.example.com/mcp'); // drop fragment
});

test('canonicalResourceUri rejects a scheme-less identifier', () => {
  expect(() => canonicalResourceUri('mcp.example.com')).toThrow();
});

test('defaultResourceMetadataUrl derives the well-known path', () => {
  expect(defaultResourceMetadataUrl('https://mcp.example.com/mcp')).toBe(
    'https://mcp.example.com/.well-known/oauth-protected-resource'
  );
});

// ── discovery (mock fetch) ───────────────────────────────────────────────────

function mockFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = routes[url];
    if (body === undefined) return new Response('not found', { status: 404 });
    return Response.json(body);
  }) as typeof fetch;
}

test('discoverProtectedResource returns the authorization servers', async () => {
  const f = mockFetch({
    'https://mcp.example.com/.well-known/oauth-protected-resource': {
      resource: 'https://mcp.example.com/mcp',
      authorization_servers: ['https://as.example.com']
    }
  });
  const r = await discoverProtectedResource('https://mcp.example.com/.well-known/oauth-protected-resource', f);
  expect(r.authorizationServers).toEqual(['https://as.example.com']);
});

test('discoverAuthServer reads the OAuth metadata well-known', async () => {
  const f = mockFetch({
    'https://as.example.com/.well-known/oauth-authorization-server': {
      authorization_endpoint: 'https://as.example.com/authorize',
      token_endpoint: 'https://as.example.com/token',
      device_authorization_endpoint: 'https://as.example.com/device'
    }
  });
  const m = await discoverAuthServer('https://as.example.com', f);
  expect(m.tokenEndpoint).toBe('https://as.example.com/token');
  expect(m.deviceAuthorizationEndpoint).toBe('https://as.example.com/device');
});

// ── Device Authorization Grant (RFC 8628) ────────────────────────────────────

// Returns the queued responses in order (last one repeats), for polling tests.
function seqFetch(steps: Array<{ status: number; body: unknown }>): typeof fetch {
  let i = 0;
  return (async (_input: string | URL | Request) => {
    const step = steps[Math.min(i, steps.length - 1)] as { status: number; body: unknown };
    i++;
    return new Response(JSON.stringify(step.body), {
      status: step.status,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
}

test('startDeviceAuthorization parses the device code response', async () => {
  const f = mockFetch({
    'https://as.example.com/device': {
      device_code: 'dev-code',
      user_code: 'WDJB-MJHT',
      verification_uri: 'https://as.example.com/device',
      verification_uri_complete: 'https://as.example.com/device?user_code=WDJB-MJHT',
      expires_in: 1800,
      interval: 5
    }
  });
  const da = await startDeviceAuthorization(
    { deviceAuthorizationEndpoint: 'https://as.example.com/device', clientId: 'c', resource: 'r' },
    f,
    1_000
  );
  expect(da.userCode).toBe('WDJB-MJHT');
  expect(da.interval).toBe(5);
  expect(da.expiresAt).toBe(1_000 + 1800 * 1000);
});

test('pollDeviceToken waits through authorization_pending then returns tokens', async () => {
  const f = seqFetch([
    { status: 400, body: { error: 'authorization_pending' } },
    { status: 200, body: { access_token: 'dev-at', token_type: 'Bearer' } }
  ]);
  const tokens = await pollDeviceToken(
    { tokenEndpoint: 't', deviceCode: 'dc', clientId: 'c', resource: 'r', interval: 1, expiresAt: 10_000 },
    f,
    { sleep: async () => {}, now: () => 1 }
  );
  expect(tokens.accessToken).toBe('dev-at');
});

test('pollDeviceToken throws on access_denied', async () => {
  const f = seqFetch([{ status: 400, body: { error: 'access_denied' } }]);
  await expect(
    pollDeviceToken(
      { tokenEndpoint: 't', deviceCode: 'dc', clientId: 'c', resource: 'r', interval: 1, expiresAt: 10_000 },
      f,
      {
        sleep: async () => {},
        now: () => 1
      }
    )
  ).rejects.toThrow(/denied/);
});

test('pollDeviceToken throws when the device code has expired', async () => {
  const f = seqFetch([{ status: 200, body: { access_token: 'x', token_type: 'Bearer' } }]);
  await expect(
    pollDeviceToken(
      { tokenEndpoint: 't', deviceCode: 'dc', clientId: 'c', resource: 'r', interval: 1, expiresAt: 0 },
      f,
      {
        sleep: async () => {},
        now: () => 1_000
      }
    )
  ).rejects.toThrow(/expired/);
});
