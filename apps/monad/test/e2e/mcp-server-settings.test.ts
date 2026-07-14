// e2e: the mcp-server-settings REST surface over a real temp ~/.monad, exercised over BOTH transports
// (TCP loopback + Unix socket). Asserts CRUD works, persists to config.json (mcpServers is SYSTEM
// config), and round-trips both the stdio and http variants of the discriminated union.

import type { MonadPaths } from '@monad/home';

import { describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envRef, initMonadHome, loadAll, loadAuth, loadConfig } from '@monad/home';

import { ModelService } from '#/handlers/settings/model/index.ts';
import { createHttpTransport } from '#/transports/http.ts';
import {
  buildHandlers,
  makeTestPaths,
  mockModel,
  seededProviderRegistry,
  serveTransport,
  TRANSPORTS
} from '../helpers.ts';

function makePaths(base: string): MonadPaths {
  return makeTestPaths(base);
}

function stdioView() {
  return {
    name: 'fs',
    transport: 'stdio' as const,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    env: { TOK: envRef('TOK') },
    enabled: true,
    trust: { autoApproveTools: [] }
  };
}

function httpView() {
  return {
    name: 'remote',
    transport: 'http' as const,
    url: 'https://mcp.example.com/sse',
    auth: { mode: 'bearer' as const, token: envRef('MCP_TOKEN') },
    enabled: true,
    trust: { autoApproveTools: ['remote.read'] }
  };
}

type Call = (method: string, path: string, body?: unknown) => Promise<Response>;
interface ServersBody {
  servers: {
    name: string;
    transport: 'stdio' | 'http';
    enabled: boolean;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    auth?: { mode: string; token?: string };
  }[];
}

async function runMcpServerCrud(call: Call, paths: MonadPaths): Promise<void> {
  // 1. empty to start
  let res = await call('GET', '/v1/settings/mcp-servers');
  expect(res.status).toBe(200);
  expect(((await res.json()) as ServersBody).servers).toEqual([]);

  // 2. upsert a stdio server + an http server
  expect((await call('PUT', '/v1/settings/mcp-servers/fs', { server: stdioView() })).status).toBe(200);
  expect((await call('PUT', '/v1/settings/mcp-servers/remote', { server: httpView() })).status).toBe(200);

  // 3. both list back with their full spec (the discriminated union round-trips)
  res = await call('GET', '/v1/settings/mcp-servers');
  const { servers } = (await res.json()) as ServersBody;
  expect(servers.length).toBe(2);
  const fs = servers.find((s) => s.name === 'fs');
  const remote = servers.find((s) => s.name === 'remote');
  expect(fs?.transport).toBe('stdio');
  expect(fs?.command).toBe('npx');
  expect(fs?.env?.TOK).toBe(envRef('TOK'));
  expect(remote?.transport).toBe('http');
  expect(remote?.url).toBe('https://mcp.example.com/sse');
  expect(remote?.auth?.token).toBe(envRef('MCP_TOKEN'));

  // 4. persisted to config.json (SYSTEM config)
  expect((await loadConfig(paths.config))?.mcpServers.find((s) => s.name === 'fs')).toMatchObject({
    transport: 'stdio',
    command: 'npx'
  });
  expect((await loadAll(paths.config, paths.profile))?.mcpServers.length).toBe(2);

  // 4b. GET single server round-trips its full spec
  res = await call('GET', '/v1/settings/mcp-servers/fs');
  const { server } = (await res.json()) as { server: ServersBody['servers'][number] };
  expect(server).toMatchObject({ name: 'fs', transport: 'stdio', command: 'npx' });

  // 4c. GET an unknown server 404s
  expect((await call('GET', '/v1/settings/mcp-servers/does-not-exist')).status).toBe(404);

  // 5. disable → reflected
  expect((await call('POST', '/v1/settings/mcp-servers/fs/disable')).status).toBe(200);
  res = await call('GET', '/v1/settings/mcp-servers');
  expect(((await res.json()) as ServersBody).servers.find((s) => s.name === 'fs')?.enabled).toBe(false);

  // 5b. enable/disable/reconnect/authorize 404 for an unknown server
  expect((await call('POST', '/v1/settings/mcp-servers/does-not-exist/enable')).status).toBe(404);
  expect((await call('POST', '/v1/settings/mcp-servers/does-not-exist/disable')).status).toBe(404);
  expect((await call('POST', '/v1/settings/mcp-servers/does-not-exist/reconnect')).status).toBe(404);
  expect((await call('POST', '/v1/settings/mcp-servers/does-not-exist/authorize')).status).toBe(404);

  // 6. remove both → gone from list AND config.json
  expect((await call('DELETE', '/v1/settings/mcp-servers/fs')).status).toBe(200);
  expect((await call('DELETE', '/v1/settings/mcp-servers/remote')).status).toBe(200);
  res = await call('GET', '/v1/settings/mcp-servers');
  expect(((await res.json()) as ServersBody).servers).toEqual([]);
  expect((await loadConfig(paths.config))?.mcpServers).toEqual([]);

  // 6b. DELETE an unknown (already-removed) server 404s
  expect((await call('DELETE', '/v1/settings/mcp-servers/fs')).status).toBe(404);
}

async function setup(): Promise<{ dir: string; paths: MonadPaths; app: ReturnType<typeof createHttpTransport> }> {
  const dir = join(tmpdir(), `monad-mcpsettings-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`);
  const paths = makePaths(dir);
  await initMonadHome(paths);
  const cfg = await loadConfig(paths.config);
  if (!cfg) throw new Error('config missing after init');
  const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry());
  const app = createHttpTransport(buildHandlers(mockModel(), { paths, modelService }));
  return { dir, paths, app };
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body)
});

for (const kind of TRANSPORTS) {
  describe(`mcp-server-settings over ${kind}`, () => {
    test('mcp-server-settings CRUD persists to config.json', async () => {
      const { dir, paths, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runMcpServerCrud((m, p, b) => t.fetch(p, jsonInit(m, b)), paths);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
}
