import { afterEach, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('packageAtomPack creates a deterministic canonical artifact and digest', async () => {
  const root = await fixture();
  const first = await packageAtomPack({ sourceDir: root });
  const firstBytes = await readFile(first.artifact);
  const second = await packageAtomPack({ sourceDir: root });

  expect(second).toEqual({
    ...first,
    files: ['atom-pack.json', 'dist/atom-pack.js', 'skills/hello/SKILL.md']
  });
  expect(await readFile(second.artifact)).toEqual(firstBytes);
  expect(await readdir(join(root, 'release'))).toEqual(['atom-pack.zip']);
  expect(second.sha256).toBe(new Bun.CryptoHasher('sha256').update(firstBytes).digest('hex'));
  expect(second.integrity).toMatch(/^sha256-[0-9a-f]{64}$/);
});

test('packageAtomPack writes a custom canonical artifact', async () => {
  const root = await fixture();
  const output = join(root, 'release', 'custom-pack.zip');
  const result = await packageAtomPack({ sourceDir: root, output });

  expect({ artifact: result.artifact, sha256: result.sha256 }).toEqual({
    artifact: output,
    sha256: new Bun.CryptoHasher('sha256').update(await readFile(output)).digest('hex')
  });
});

test('packageAtomPack requires a built entry and rejects symlinked content', async () => {
  const missing = await fixture();
  await rm(join(missing, 'dist', 'atom-pack.js'));
  await expect(packageAtomPack({ sourceDir: missing })).rejects.toThrow(/entry is missing/i);

  const linked = await fixture();
  await symlink(join(linked, 'dist', 'atom-pack.js'), join(linked, 'assets'));
  await expect(packageAtomPack({ sourceDir: linked })).rejects.toThrow(/symlinks/i);
});
