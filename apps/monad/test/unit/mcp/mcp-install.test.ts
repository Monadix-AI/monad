// Offline tests for the registry-style MCP installer (services/mcp-install): consent is injected, so
// nothing connects. Covers the file write (file-MCP format + trust), default-deny, http auth limits,
// list, and remove.

import type { McpServerWrite } from '@monad/protocol';

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installMcpAtom, listInstalledMcpAtoms, removeMcpAtom } from '#/capabilities/mcp/install/index.ts';

let mcpDir: string;
beforeEach(async () => {
  mcpDir = await mkdtemp(join(tmpdir(), 'monad-mcpatom-'));
});
afterEach(async () => {
  await rm(mcpDir, { recursive: true, force: true });
});

const stdio = (name: string, autoApprove: string[] = []): McpServerWrite => ({
  name,
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'some-mcp'],
  enabled: true,
  trust: { autoApproveTools: autoApprove, hostEscape: false }
});

const readFile = async (name: string) =>
  JSON.parse(await Bun.file(join(mcpDir, `${name}.json`)).text()) as {
    mcpServers: Record<
      string,
      {
        command?: string;
        url?: string;
        headers?: Record<string, string>;
        trust?: { autoApproveTools?: string[]; hostEscape?: boolean };
      }
    >;
  };

test('installs a stdio (npx) server as a file-MCP atom with its trust block', async () => {
  const out = await installMcpAtom(stdio('fs', ['fs__read']), { mcpDir, consent: () => true });
  expect(out).toMatchObject({ name: 'fs' });

  const file = await readFile('fs');
  expect(file.mcpServers.fs).toMatchObject({ command: 'npx', trust: { autoApproveTools: ['fs__read'] } });
});

test('default-deny: consent=false writes no file and reports needsConsent', async () => {
  const out = await installMcpAtom(stdio('fs'), { mcpDir, consent: () => false });
  expect(out.needsConsent).toBe(true);
  expect(await Bun.file(join(mcpDir, 'fs.json')).exists()).toBe(false);
});

test('the consent prompt surfaces the command that will run', async () => {
  let info: { warnings: string[] } | undefined;
  await installMcpAtom(stdio('fs'), {
    mcpDir,
    consent: (i) => {
      info = i;
      return false;
    }
  });
  expect(info?.warnings).toEqual(['runs `npx -y some-mcp` on your machine when the agent uses it']);
});

test('installs an unauthenticated http server', async () => {
  const server: McpServerWrite = {
    name: 'remote',
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
    auth: { mode: 'none' },
    enabled: true,
    trust: { autoApproveTools: [], hostEscape: false }
  };
  await installMcpAtom(server, { mcpDir, consent: () => true });
  const file = await readFile('remote');
  expect(file.mcpServers.remote).toMatchObject({ url: 'https://mcp.example.com/mcp' });
});

test('stores a write-only bearer credential directly in the owning file-MCP setting', async () => {
  const bearer: McpServerWrite = {
    name: 'remote',
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
    auth: { mode: 'bearer', token: { action: 'replace', value: 'private-mcp-canary' } },
    enabled: true,
    trust: { autoApproveTools: [], hostEscape: false }
  };
  await installMcpAtom(bearer, { mcpDir, consent: () => true });
  expect(await readFile('remote')).toEqual({
    mcpServers: {
      remote: {
        url: 'https://mcp.example.com/mcp',
        headers: { authorization: 'Bearer private-mcp-canary' },
        trust: { autoApproveTools: [] }
      }
    }
  });
});

test('rejects an invalid server name', async () => {
  await expect(installMcpAtom(stdio('../evil'), { mcpDir, consent: () => true })).rejects.toThrow(/invalid/);
});

test('list + remove round-trip', async () => {
  await installMcpAtom(stdio('fs'), { mcpDir, consent: () => true });
  await installMcpAtom(stdio('git'), { mcpDir, consent: () => true });
  expect((await listInstalledMcpAtoms(mcpDir)).map((s) => s.name).sort()).toEqual(['fs', 'git']);

  await removeMcpAtom(mcpDir, 'fs');
  expect((await listInstalledMcpAtoms(mcpDir)).map((s) => s.name)).toEqual(['git']);
});

test('list skips file-MCP atoms with non-http URLs', async () => {
  await Bun.write(
    join(mcpDir, 'bad.json'),
    JSON.stringify({ mcpServers: { bad: { url: 'file:///etc/passwd' } } }, null, 2)
  );
});
