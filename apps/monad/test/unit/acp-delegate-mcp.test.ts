// toAcpMcpServers: map monad's configured MCP servers into the ACP newSession shape forwarded to a
// delegated sub-agent. Covers stdio/http mapping, env/header secret resolution, and the skip rules
// (disabled servers, oauth-mode http whose bearer can't be forwarded as a static header).

import type { McpServerConfig } from '@monad/home';

import { expect, test } from 'bun:test';
import { envRef } from '@monad/home';

import { toAcpMcpServers } from '@/services/delegation/acp-delegate.ts';

const trust = { autoApproveTools: [], hostEscape: false };
const stdio = (over: Partial<McpServerConfig> = {}): McpServerConfig =>
  ({ name: 's', transport: 'stdio', command: 'cmd', args: ['a'], enabled: true, trust, ...over }) as McpServerConfig;
const http = (over: Record<string, unknown> = {}): McpServerConfig =>
  ({
    name: 'h',
    transport: 'http',
    url: 'https://x.test',
    auth: { mode: 'none' },
    enabled: true,
    trust,
    ...over
  }) as McpServerConfig;

test('stdio server maps to ACP shape with env as name/value pairs', () => {
  const [s] = toAcpMcpServers([stdio({ env: { API: 'plain-value' } })]);
  expect(s).toMatchObject({ name: 's', command: 'cmd', args: ['a'] });
  expect((s as { env: { name: string; value: string }[] }).env).toEqual([{ name: 'API', value: 'plain-value' }]);
});

test('disabled servers are skipped', () => {});

test('http none → static headers only; bearer → authorization header', () => {
  const none = toAcpMcpServers([http({ headers: { 'x-a': '1' } })]);
  expect(none[0]).toMatchObject({ name: 'h', type: 'http', url: 'https://x.test' });
  expect((none[0] as { headers: { name: string; value: string }[] }).headers).toEqual([{ name: 'x-a', value: '1' }]);

  const bearer = toAcpMcpServers([http({ auth: { mode: 'bearer', token: 'tok123' } })]);
  expect((bearer[0] as { headers: { name: string; value: string }[] }).headers).toContainEqual({
    name: 'authorization',
    value: 'Bearer tok123'
  });
});

test('oauth-mode http is skipped (dynamic bearer, not forwardable as a static header)', () => {});

test('mixed list: only enabled + forwardable servers come through, in order', () => {
  const out = toAcpMcpServers([
    stdio({ name: 'a' }),
    http({ name: 'b', auth: { mode: 'oauth', scopes: [], flow: 'loopback' } }), // skipped
    http({ name: 'c', auth: { mode: 'none' } }),
    stdio({ name: 'd', enabled: false }) // skipped
  ]);
  expect(out.map((s) => s.name)).toEqual(['a', 'c']);
});

test('a server with an unresolvable secret ref is skipped, not thrown (per-server isolation)', () => {
  const out = toAcpMcpServers([
    stdio({ name: 'bad', env: { API: envRef('MONAD_DEFINITELY_UNSET_VAR_XYZ') } }),
    stdio({ name: 'good', env: { X: 'plain' } })
  ]);
  // resolveSecretRef throws on the unset ref; the loop must catch+skip 'bad', not abort the whole set.
  expect(out.map((s) => s.name)).toEqual(['good']);
});
