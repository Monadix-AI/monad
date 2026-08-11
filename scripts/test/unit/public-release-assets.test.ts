import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isPublicReleaseAsset, stagePublicReleaseAssets } from '../../lib/public-release-assets.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

test('staging publishes install and update assets but excludes dist intermediates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'monad-public-release-assets-'));
  temporaryDirectories.push(root);
  const source = join(root, 'artifacts');
  const destination = join(root, 'release-assets');
  await mkdir(source, { recursive: true });
  const publicNames = [
    'install.ps1',
    'install.sh',
    'monad-aarch64-apple-darwin-update',
    'monad-aarch64-apple-darwin.tar.gz',
    'monad-aarch64-apple-darwin.tar.gz.sha256',
    'monad-aarch64-pc-windows-msvc-update',
    'monad-aarch64-pc-windows-msvc.zip',
    'monad-aarch64-pc-windows-msvc.zip.sha256',
    'monad-power-pack.atom-pack.zip',
    'monad-power-pack.atom-pack.zip.sha256'
  ];
  const internalNames = [
    'aarch64-apple-darwin-dist-manifest.json',
    'monad-installer.ps1',
    'monad-installer.sh',
    'sha256.sum',
    'source.tar.gz',
    'source.tar.gz.sha256'
  ];
  await Promise.all([...publicNames, ...internalNames].map((name) => writeFile(join(source, name), name)));

  expect(await stagePublicReleaseAssets(source, destination)).toEqual([...publicNames].sort());
  expect((await readdir(destination)).sort()).toEqual([...publicNames].sort());
  expect(internalNames.every((name) => !isPublicReleaseAsset(name))).toBeTrue();
});

test('staging fails closed when an updater has no matching archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'monad-incomplete-release-assets-'));
  temporaryDirectories.push(root);
  const source = join(root, 'artifacts');
  await mkdir(source, { recursive: true });
  const names = [
    'install.ps1',
    'install.sh',
    'monad-aarch64-apple-darwin-update',
    'monad-power-pack.atom-pack.zip',
    'monad-power-pack.atom-pack.zip.sha256'
  ];
  await Promise.all(names.map((name) => writeFile(join(source, name), name)));

  expect(stagePublicReleaseAssets(source, join(root, 'release-assets'))).rejects.toThrow(
    'missing platform archive for updater target aarch64-apple-darwin'
  );
});
