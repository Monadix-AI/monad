import { afterEach, expect, test } from 'bun:test';
import { mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { packageAtomPack } from '../../src/atom-pack/package.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = join(tmpdir(), `monad-atom-pack-${process.pid}-${Date.now()}-${roots.length}`);
  roots.push(root);
  await mkdir(join(root, 'dist'), { recursive: true });
  await mkdir(join(root, 'skills', 'hello'), { recursive: true });
  await Bun.write(
    join(root, 'atom-pack.json'),
    `${JSON.stringify({ name: 'hello-pack', version: '1.2.3', sdkVersion: '0', atoms: ['command', 'skill'] })}\n`
  );
  await Bun.write(join(root, 'dist', 'atom-pack.js'), 'export default { manifest: {}, register() {} };\n');
  await Bun.write(join(root, 'skills', 'hello', 'SKILL.md'), '# Hello\n');
  return root;
}

test('packageAtomPack creates a deterministic canonical artifact and checksum', async () => {
  const root = await fixture();
  const first = await packageAtomPack({ sourceDir: root });
  const firstBytes = await readFile(first.artifact);
  const second = await packageAtomPack({ sourceDir: root });
  const checksum = await readFile(second.checksumFile, 'utf8');

  expect(second).toEqual({
    ...first,
    files: ['atom-pack.json', 'dist/atom-pack.js', 'skills/hello/SKILL.md']
  });
  expect(await readFile(second.artifact)).toEqual(firstBytes);
  expect(checksum).toBe(`${second.sha256}  atom-pack.zip\n`);
  expect(second.integrity).toMatch(/^sha256-[0-9a-f]{64}$/);
});

test('packageAtomPack names a custom checksum after its artifact', async () => {
  const root = await fixture();
  const output = join(root, 'release', 'custom-pack.zip');
  const result = await packageAtomPack({ sourceDir: root, output });

  expect(await readFile(result.checksumFile, 'utf8')).toBe(`${result.sha256}  ${basename(output)}\n`);
});

test('packageAtomPack requires a built entry and rejects symlinked content', async () => {
  const missing = await fixture();
  await rm(join(missing, 'dist', 'atom-pack.js'));
  await expect(packageAtomPack({ sourceDir: missing })).rejects.toThrow(/entry is missing/i);

  const linked = await fixture();
  await symlink(join(linked, 'dist', 'atom-pack.js'), join(linked, 'assets'));
  await expect(packageAtomPack({ sourceDir: linked })).rejects.toThrow(/symlinks/i);
});
