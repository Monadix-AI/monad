// Verifies the file/pack-driven MCP path (connectFileMcpServers): a server declared in
// atoms/mcp/*.json or atoms/packs/<pack>/mcp.json now carries the SAME trust model as a config.json
// server (autoApprove + pinned-tool-hash rug-pull guard), and two sources pointing at one http
// server collapse to a single connection (dedup by normalized url).

import type { MonadPaths } from '@monad/home';
import type { McpConnection } from '#/capabilities/tools';

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connectFileMcpServers } from '#/bootstrap/mcp.ts';
import { toolResult } from '#/capabilities/tools/types.ts';
import { AtomPackRegistry } from '#/handlers/atom-pack/index.ts';

const fixture = join(import.meta.dir, '../unit/tools/fixtures/mock-mcp-server.ts');

let base: string;
let open: McpConnection[] = [];

beforeEach(() => {
  base = join(tmpdir(), `monad-filemcp-${Date.now()}-${Math.floor(performance.now())}`);
  open = [];
});
afterEach(async () => {
  for (const c of open) await c.close();
  await rm(base, { recursive: true, force: true });
});

function makePaths(): MonadPaths {
  const dev = '/dev/null';
  return {
    home: base,
    runtime: dev,
    configs: dev,
    dbDir: dev,
    db: dev,
    config: dev,
    profile: dev,
    approvals: dev,
    credentials: dev,
    auth: dev,
    tls: dev,
    workspace: dev,
    providers: dev,
    skills: dev,
    skillsLock: '/dev/null/skills.lock',
    locales: dev,
    mcp: join(base, 'atoms', 'mcp'),
    atoms: join(base, 'atoms'),
    packs: join(base, 'atoms', 'packs'),
    agents: dev,
    memory: dev,
    backup: dev,
    cache: dev,
    bin: dev,
    sock: dev,
    kvSock: dev,
    pid: dev,
    logs: dev
  };
}

async function writeMcpFile(rel: string, mcpServers: Record<string, unknown>): Promise<void> {
  const p = join(base, rel);
  await mkdir(join(p, '..'), { recursive: true });
  await Bun.write(p, JSON.stringify({ mcpServers }));
}

test('file MCP honors the trust block: autoApprove exempts a tool from the gate', async () => {
  await writeMcpFile('atoms/mcp/srv.json', {
    mock: { command: 'bun', args: [fixture], trust: { autoApproveTools: ['mock__screenshot'] } }
  });
  const registry = new AtomPackRegistry();
  open = await connectFileMcpServers(makePaths(), registry);

  const screenshot = registry.tools.get('mock__screenshot');
  const echo = registry.tools.get('mock__echo');
  if (!screenshot || !echo) throw new Error('file MCP tools were not registered');
  expect(screenshot.highRisk).toBe(false); // auto-approved → exempt
  expect(echo.highRisk).toBe(true); // not listed → stays gated
});

test('file MCP rejects a server whose tool set no longer matches its pinned hash', async () => {
  await writeMcpFile('atoms/mcp/srv.json', {
    mock: { command: 'bun', args: [fixture], trust: { pinnedToolHash: 'deadbeef-not-the-real-hash' } }
  });
  const registry = new AtomPackRegistry();
  open = await connectFileMcpServers(makePaths(), registry);

  expect(registry.tools.get('mock__echo')).toBeUndefined();
  expect(open.length).toBe(0); // pin mismatch → connection refused + closed
});

test('a file MCP atom with top-level enabled:false is skipped (no tools registered)', async () => {
  await mkdir(join(base, 'atoms', 'mcp'), { recursive: true });
  await Bun.write(
    join(base, 'atoms', 'mcp', 'srv.json'),
    JSON.stringify({ enabled: false, mcpServers: { mock: { command: 'bun', args: [fixture] } } })
  );
  const registry = new AtomPackRegistry();
  open = await connectFileMcpServers(makePaths(), registry);
  expect(registry.tools.get('mock__echo')).toBeUndefined(); // disabled file → no spawn, no tools
});

test('a file MCP server installed after the first scan is picked up on re-scan (hot install)', async () => {
  const paths = makePaths();
  const registry = new AtomPackRegistry();

  // First boot scan: nothing installed yet.
  open.push(...(await connectFileMcpServers(paths, registry)));
  expect(registry.tools.get('mock__echo')).toBeUndefined();

  // Install a server, then re-scan — exactly what rediscovery's reconnectFileMcp does.
  await writeMcpFile('atoms/mcp/srv.json', { mock: { command: 'bun', args: [fixture] } });
  open.push(...(await connectFileMcpServers(paths, registry)));
  expect(registry.tools.get('mock__echo')).toBeDefined(); // hot-registered into the live registry
});

test('removing a file MCP server clears its tools on re-scan (clearToolsFrom)', async () => {
  const { rm: rmFile } = await import('node:fs/promises');
  const paths = makePaths();
  const registry = new AtomPackRegistry();

  await writeMcpFile('atoms/mcp/srv.json', { mock: { command: 'bun', args: [fixture] } });
  open.push(...(await connectFileMcpServers(paths, registry)));
  expect(registry.tools.get('mock__echo')).toBeDefined();

  // Uninstall + re-scan, exactly as reconnectFileMcp does: clear the 'file-mcp' source, then re-scan.
  await rmFile(join(base, 'atoms', 'mcp', 'srv.json'));
  registry.clearToolsFrom('file-mcp');
  open.push(...(await connectFileMcpServers(paths, registry)));
  expect(registry.tools.get('mock__echo')).toBeUndefined(); // gone, no restart
});

test('clearToolsFrom only drops the named source — static (builtin/config-MCP) tools persist', () => {
  const registry = new AtomPackRegistry();
  registry.registerTool({ name: 'builtin.read', description: 'b', scopes: [], run: async () => toolResult('ok') }); // default 'static'
  registry.registerTool(
    { name: 'pack.tool', description: 'p', scopes: [], run: async () => toolResult('ok') },
    'atom-pack'
  );

  registry.clearToolsFrom('atom-pack');
  expect(registry.tools.get('pack.tool')).toBeUndefined();
  expect(registry.tools.get('builtin.read')).toBeDefined(); // boot-once tool survives
});

test('two packs declaring the same http server collapse to one connection', async () => {
  let initCount = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const msg = (await req.json()) as { id?: number; method: string };
      if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (msg.method === 'initialize') {
        initCount++;
        return Response.json({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 's', version: '0' }
          }
        });
      }
      if (msg.method === 'tools/list')
        return Response.json({
          jsonrpc: '2.0',
          id: msg.id,
          result: { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }] }
        });
      return Response.json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } });
    }
  });
  try {
    const url = `http://127.0.0.1:${server.port}/mcp`;
    // Same remote, declared twice (once with a trailing slash to prove normalization). Operator-
    // authored atoms/mcp files may legitimately target a local 127.0.0.1 MCP server. System-level
    // view: ONE server.
    await writeMcpFile('atoms/mcp/srvA.json', { srvA: { url } });
    await writeMcpFile('atoms/mcp/srvB.json', { srvB: { url: `${url}/` } });
    const registry = new AtomPackRegistry();
    open = await connectFileMcpServers(makePaths(), registry);

    expect(open.length).toBe(1);
    expect(initCount).toBe(1);
    // The winning (first, by sorted file) server's tool is registered exactly once.
    expect(registry.tools.get('srvA__echo')).toBeDefined();
    expect(registry.tools.get('srvB__echo')).toBeUndefined();
  } finally {
    server.stop(true);
  }
});

test('a pack-declared MCP targeting loopback is rejected (SSRF guard)', async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response('nope', { status: 500 }) });
  try {
    // A downloadable pack is untrusted: it must not be able to point an MCP server at a loopback /
    // private address (the daemon's own API, cloud metadata, other local services).
    await writeMcpFile('atoms/packs/evil/mcp.json', { x: { url: `http://127.0.0.1:${server.port}/mcp` } });
    const registry = new AtomPackRegistry();
    open = await connectFileMcpServers(makePaths(), registry);
    expect(open.length).toBe(0); // SSRF guard threw → server skipped
    expect(registry.tools.get('x__echo')).toBeUndefined();
  } finally {
    server.stop(true);
  }
});
