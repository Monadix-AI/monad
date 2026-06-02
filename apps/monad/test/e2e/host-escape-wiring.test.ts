// Verifies the host-escape WIRING in bootstrap: connectMcpServers tags a hostEscape server's
// NON-auto-approved tools with the host-control gate key, so the approval engine treats them as the
// session-grantable desktop-control class (never a permanent global allow). Auto-approved read-only
// tools are exempt and ungated. Pairs with approvals-engine.test.ts (which proves the SEMANTICS of
// that key) — this proves the daemon actually attaches it.

import type { MonadPaths } from '@monad/home';

import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createDefaultConfig } from '@monad/home';

import { HOST_CONTROL_KEY } from '@/agent/approvals/engine.ts';
import { connectMcpServers } from '@/bootstrap/mcp.ts';
import { AtomPackRegistry } from '@/handlers/atom-pack/index.ts';

const fixture = join(import.meta.dir, '../unit/tools/fixtures/mock-mcp-server.ts');

const paths: MonadPaths = {
  home: '/dev/null',
  runtime: '/dev/null',
  configs: '/dev/null',
  dbDir: '/dev/null',
  db: '/dev/null',
  config: '/dev/null/config.json',
  profile: '/dev/null/profile.json',
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

test('hostEscape server: non-read-only tools get the host-control gate key; read-only stays ungated', async () => {
  const cfg = createDefaultConfig('prn_t', 't');
  // A hostEscape server (stand-in for the computer-use preset) with screenshot auto-approved.
  cfg.mcpServers = [
    {
      name: 'mock',
      transport: 'stdio',
      command: 'bun',
      args: [fixture],
      enabled: true,
      trust: { autoApproveTools: ['mock__screenshot'], hostEscape: true }
    }
  ];
  const registry = new AtomPackRegistry();
  await connectMcpServers(cfg, paths, registry);

  const mutating = registry.tools.get('mock__echo'); // not auto-approved → host-escape
  const readOnly = registry.tools.get('mock__screenshot'); // auto-approved → exempt
  if (!mutating || !readOnly) throw new Error('mock server tools were not registered');

  // Mutating tool is gated as the host-control class and stays high-risk.
  expect(mutating.gateKey?.({})).toBe(HOST_CONTROL_KEY);
  expect(mutating.highRisk).toBe(true);
  // Read-only tool is auto-approved and carries no host-escape key.
  expect(readOnly.highRisk).toBe(false);
  expect(readOnly.gateKey).toBeUndefined();
});
