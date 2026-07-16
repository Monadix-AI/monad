import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { optionalPeerExternals } from '../../lib/release-optional-peers.ts';

const temporaryDirectories: string[] = [];
const root = join(import.meta.dir, '..', '..', '..');
const monadDirectory = join(root, 'apps', 'monad');
const mem0Manifest = join(monadDirectory, 'node_modules', 'mem0ai', 'package.json');
const mem0Entry = Bun.resolveSync('mem0ai/oss', monadDirectory);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

test('optionalPeerExternals returns declared optional peers in stable order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monad-release-optional-peers-'));
  temporaryDirectories.push(directory);
  const manifestPath = join(directory, 'package.json');
  await writeFile(
    manifestPath,
    JSON.stringify({
      peerDependencies: { required: '^1', zebra: '^1', alpha: '^1' },
      peerDependenciesMeta: { zebra: { optional: true }, missing: { optional: true }, alpha: { optional: true } }
    })
  );

  expect(await optionalPeerExternals(manifestPath)).toEqual(['alpha', 'zebra']);
});

test('optionalPeerExternals rejects a manifest without optional peer metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monad-release-optional-peers-'));
  temporaryDirectories.push(directory);
  const manifestPath = join(directory, 'package.json');
  await writeFile(manifestPath, JSON.stringify({ peerDependencies: { alpha: '^1' } }));

  expect(optionalPeerExternals(manifestPath)).rejects.toThrow(`optional peer metadata is missing from ${manifestPath}`);
});

test('release compile accepts an installed package with unresolved optional peers', async () => {
  expect(() => Bun.resolveSync('@huggingface/transformers', monadDirectory)).toThrow();
  const directory = await mkdtemp(join(tmpdir(), 'monad-release-mem0-compile-'));
  temporaryDirectories.push(directory);
  const entry = join(directory, 'entry.ts');
  await writeFile(entry, `await import(${JSON.stringify(mem0Entry)});\n`);

  const build = await Bun.build({
    entrypoints: [entry],
    outdir: join(directory, 'out'),
    target: 'bun',
    external: await optionalPeerExternals(mem0Manifest)
  });

  expect(build.success, build.logs.map((log) => log.message).join('\n')).toBe(true);
});
