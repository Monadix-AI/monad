// Verifies the config.json MCP diff-reconnect (reloadConfigMcpServers): on a settings hot-reload an
// ADDED server connects, a REMOVED server disconnects (its tools cleared from the registry), an
// UNCHANGED server keeps its live connection untouched (no needless re-handshake), and a CHANGED
// server is torn down + reconnected. This is what makes a config.json edit apply without a restart.

import type { McpServerConfig, MonadPaths } from '@monad/environment';

import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createDefaultConfig } from '@monad/environment';

import {
  collectMcpStatus,
  connectMcpServers,
  reconnectOneMcpServer,
  reloadConfigMcpServers
} from '#/capabilities/mcp/service.ts';
import { AtomPackRegistry } from '#/handlers/atom-pack/index.ts';

const fixture = join(import.meta.dir, '../unit/tools/fixtures/mock-mcp-server.ts');

const paths: MonadPaths = {
  home: '/dev/null',
  runtime: '/dev/null',
  configs: '/dev/null',
  dbDir: '/dev/null',
  db: '/dev/null',
  config: '/dev/null/config.json',
  agentsConfig: '/dev/null/agents.json',
  mesh: '/dev/null/mesh.json',
  approvals: '/dev/null/approvals.json',
  credentials: '/dev/null',
  auth: '/dev/null/auth.json',
  tls: '/dev/null/tls',
  workspace: '/dev/null',
  providers: '/dev/null',
  skills: '/dev/null',
  skillsLock: '/dev/null/skills.lock',
  locales: '/dev/null',
  mcp: '/dev/null',
  atoms: '/dev/null',
  packs: '/dev/null',
  agents: '/dev/null',
  memory: '/dev/null',
  backup: '/dev/null',
  cache: '/dev/null',
  bin: '/dev/null',
  sock: '/dev/null/s.sock',
  kvSock: '/dev/null/kv.sock',
  pid: '/dev/null/p.pid',
  logs: '/dev/null/d.log'
};

const server = (name: string): McpServerConfig => ({
  name,
  transport: 'stdio',
  command: 'bun',
  args: [fixture],
  enabled: true,
  trust: { autoApproveTools: [], hostEscape: false }
});

test('reloadConfigMcpServers diffs: add connects, remove clears tools, unchanged keeps the same connection', async () => {
  const cfg = createDefaultConfig('t');
  cfg.mcpServers = [server('a'), server('b')];
  const registry = new AtomPackRegistry();
  const handle = await connectMcpServers(cfg, paths, registry);

  expect(handle.connections.has('a')).toBe(true);
  expect(handle.connections.has('b')).toBe(true);
  expect(registry.tools.has('a__echo')).toBe(true);
  expect(registry.tools.has('b__echo')).toBe(true);
  const connA = handle.connections.get('a')?.conn;

  // Hot-reload: keep 'a' (identical spec), drop 'b', add 'c'.
  const next = createDefaultConfig('t');
  next.mcpServers = [server('a'), server('c')];
  const handle2 = await reloadConfigMcpServers(handle.connections, next, paths, registry);

  // Unchanged 'a' is carried over by identity — NOT re-handshaked.
  expect(handle2.connections.get('a')?.conn).toBe(connA);
  // Removed 'b' is disconnected and its tools cleared.
  expect(handle2.connections.has('b')).toBe(false);
  expect(registry.tools.has('b__echo')).toBe(false);
  // Added 'c' connected and its tools registered.
  expect(handle2.connections.has('c')).toBe(true);
  expect(registry.tools.has('c__echo')).toBe(true);

  for (const { conn } of handle2.connections.values()) await conn.close();
});

test('collectMcpStatus reports ready / disabled / failed across config servers', async () => {
  const cfg = createDefaultConfig('t');
  cfg.mcpServers = [
    server('ok'),
    { ...server('off'), enabled: false },
    {
      name: 'broken',
      transport: 'stdio',
      command: 'definitely-not-a-real-binary-xyz',
      enabled: true,
      trust: { autoApproveTools: [], hostEscape: false }
    }
  ];
  const registry = new AtomPackRegistry();
  const handle = await connectMcpServers(cfg, paths, registry);

  const status = collectMcpStatus({
    cfg,
    config: handle.connections,
    configStatus: handle.status,
    file: [],
    obscura: { connected: false, tools: [] }
  });
  const by = new Map(status.map((s) => [s.name, s]));
  expect(by.get('ok')?.state).toBe('ready');
  expect(by.get('ok')?.toolCount ?? 0).toBeGreaterThan(0);
  expect(by.get('off')?.state).toBe('disabled');
  expect(by.get('broken')?.state).toBe('failed'); // spawn fails → never connected

  for (const { conn } of handle.connections.values()) await conn.close();
});

test('collectMcpStatus reports enabled config servers as starting before their handshake finishes', () => {
  const cfg = createDefaultConfig('t');
  cfg.mcpServers = [server('slow')];

  const status = collectMcpStatus({
    cfg,
    config: new Map(),
    configStatus: new Map([['slow', { state: 'starting' as const }]]),
    file: [],
    obscura: { connected: false, tools: [] }
  });

  expect(status).toEqual([
    {
      name: 'slow',
      source: 'config',
      transport: 'stdio',
      state: 'starting',
      toolCount: 0,
      tools: []
    }
  ]);
});

test('reloadConfigMcpServers reconnects a CHANGED server (new connection, tools re-registered)', async () => {
  const cfg = createDefaultConfig('t');
  cfg.mcpServers = [server('a')];
  const registry = new AtomPackRegistry();
  const handle = await connectMcpServers(cfg, paths, registry);
  const connA = handle.connections.get('a')?.conn;
  expect(registry.tools.has('a__echo')).toBe(true);

  // Edit 'a' (a content change → reconnect). requestTimeoutMs differs, so specEqual is false.
  const next = createDefaultConfig('t');
  next.mcpServers = [{ ...server('a'), requestTimeoutMs: 5000 }];
  const handle2 = await reloadConfigMcpServers(handle.connections, next, paths, registry);

  expect(handle2.connections.has('a')).toBe(true);
  expect(handle2.connections.get('a')?.conn).not.toBe(connA); // fresh connection
  expect(registry.tools.has('a__echo')).toBe(true); // re-registered

  for (const { conn } of handle2.connections.values()) await conn.close();
});

test('reconnectOneMcpServer updates status when a previously ready server is refused', async () => {
  const cfg = createDefaultConfig('t');
  cfg.mcpServers = [server('a')];
  const registry = new AtomPackRegistry();
  const handle = await connectMcpServers(cfg, paths, registry);

  expect(handle.connections.has('a')).toBe(true);
  expect(handle.status.get('a')?.state).toBe('ready');

  const next = createDefaultConfig('t');
  next.mcpServers = [
    {
      ...server('a'),
      trust: { autoApproveTools: [], hostEscape: false, pinnedToolHash: 'deadbeef-not-the-real-hash' }
    }
  ];
  const handle2 = await reconnectOneMcpServer('a', handle, next, paths, registry);

  expect(handle2.connections.has('a')).toBe(false);
  expect(handle2.status.get('a')).toEqual({
    state: 'failed',
    error: 'tool set refused by trust policy'
  });
  expect(registry.tools.has('a__echo')).toBe(false);
});
