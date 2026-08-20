import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Access internal scan helpers via the fetcher factory (test the public contract instead of
// internals): build a minimal StagedAtomPack and assert the fileAtoms shape.

import { createAtomFetcher } from '#/atoms/install/fetch.ts';
import { parseAtomPackSource } from '#/atoms/install/source.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'monad-scan-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeManifest(root: string) {
  const entry = 'dist/atom-pack.js';
  const manifest = { name: 'test-pack', version: '1.0.0', sdkVersion: '1', atoms: [], entry };
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'atom-pack.json'), JSON.stringify(manifest));
  await writeFile(join(root, entry), '// bundle');
}

describe('local fetcher file-based atom scan', () => {
  test('empty pack has empty fileAtoms', async () => {
    await writeManifest(dir);
    const fetcher = createAtomFetcher();
    const staged = await fetcher(parseAtomPackSource(dir));
    expect(staged.fileAtoms).toEqual({ skills: [], mcpServers: [], locales: [] });
  });

  test('detects skills with SKILL.md', async () => {
    await writeManifest(dir);
    await mkdir(join(dir, 'skills', 'my-skill'), { recursive: true });
    await writeFile(join(dir, 'skills', 'my-skill', 'SKILL.md'), '---\nname: my-skill\n---\nbody');
    const fetcher = createAtomFetcher();
    const staged = await fetcher(parseAtomPackSource(dir));
    expect(staged.fileAtoms?.skills).toEqual(['my-skill']);
  });

  test('ignores skill dirs without SKILL.md', async () => {
    await writeManifest(dir);
    await mkdir(join(dir, 'skills', 'no-skill'), { recursive: true });
    await writeFile(join(dir, 'skills', 'no-skill', 'README.md'), 'readme only');
    const fetcher = createAtomFetcher();
    const staged = await fetcher(parseAtomPackSource(dir));
    expect(staged.fileAtoms?.skills).toEqual([]);
  });

  test('detects MCP server names from mcp.json', async () => {
    await writeManifest(dir);
    await writeFile(
      join(dir, 'mcp.json'),
      JSON.stringify({
        mcpServers: { github: { command: 'npx', args: ['@mcp/github'] }, gitlab: { url: 'http://localhost' } }
      })
    );
    const fetcher = createAtomFetcher();
    const staged = await fetcher(parseAtomPackSource(dir));
    expect(staged.fileAtoms?.mcpServers).toEqual(['github', 'gitlab']);
  });

  test('silently ignores malformed mcp.json', async () => {
    await writeManifest(dir);
    await writeFile(join(dir, 'mcp.json'), 'not json{{');
    const fetcher = createAtomFetcher();
    const staged = await fetcher(parseAtomPackSource(dir));
    expect(staged.fileAtoms?.mcpServers).toEqual([]);
  });

  test('detects locale tags from locales/<lng>/ dirs', async () => {
    await writeManifest(dir);
    await mkdir(join(dir, 'locales', 'en'), { recursive: true });
    await mkdir(join(dir, 'locales', 'zh-CN'), { recursive: true });
    await writeFile(join(dir, 'locales', 'en', 'translation.json'), '{}');
    await writeFile(join(dir, 'locales', 'zh-CN', 'translation.json'), '{}');
    const fetcher = createAtomFetcher();
    const staged = await fetcher(parseAtomPackSource(dir));
    expect(staged.fileAtoms?.locales.sort()).toEqual(['en', 'zh-CN'].sort());
  });

  test('detects all three kinds together', async () => {
    await writeManifest(dir);
    await mkdir(join(dir, 'skills', 'alpha'), { recursive: true });
    await writeFile(join(dir, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\n---\nbody');
    await mkdir(join(dir, 'locales', 'en'), { recursive: true });
    await writeFile(join(dir, 'locales', 'en', 'translation.json'), '{}');
    await writeFile(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { my_server: { command: 'my-bin' } } }));
    const fetcher = createAtomFetcher();
    const staged = await fetcher(parseAtomPackSource(dir));
    expect(staged.fileAtoms).toEqual({ skills: ['alpha'], mcpServers: ['my_server'], locales: ['en'] });
  });
});
