import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverFileMcpSources } from '#/capabilities/mcp/service.ts';
import { makeTestPaths } from '../../helpers.ts';

test('file MCP discovery includes agent-private files with their owner directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'monad-private-mcp-'));
  try {
    const paths = makeTestPaths(root, {
      mcp: join(root, 'atoms', 'mcp'),
      packs: join(root, 'atoms', 'packs'),
      agents: join(root, 'agents')
    });
    await Promise.all([
      mkdir(paths.mcp, { recursive: true }),
      mkdir(join(paths.packs, 'pack-one'), { recursive: true }),
      mkdir(join(paths.agents, 'researcher', 'mcp'), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(paths.mcp, 'global.json'), '{}'),
      writeFile(join(paths.packs, 'pack-one', 'mcp.json'), '{}'),
      writeFile(join(paths.agents, 'researcher', 'mcp', 'private.json'), '{}')
    ]);

    expect(await discoverFileMcpSources(paths)).toEqual([
      {
        source: 'global',
        filePath: join(paths.mcp, 'global.json'),
        trusted: true
      },
      {
        source: 'pack-one',
        filePath: join(paths.packs, 'pack-one', 'mcp.json'),
        trusted: false
      },
      {
        source: 'researcher/private',
        filePath: join(paths.agents, 'researcher', 'mcp', 'private.json'),
        trusted: true,
        agentDir: 'researcher'
      }
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
