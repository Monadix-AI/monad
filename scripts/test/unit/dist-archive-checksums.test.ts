import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readArchiveSha256s } from '../../lib/dist-archive-checksums.ts';

test('archive checksum loading returns the exact platform digest map', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monad-archive-checksums-'));
  const mac = 'monad-aarch64-apple-darwin.tar.gz';
  const windows = 'monad-x86_64-pc-windows-msvc.zip';
  const macDigest = 'a'.repeat(64);
  const windowsDigest = 'b'.repeat(64);
  try {
    await Promise.all([
      Bun.write(join(directory, mac), 'mac archive'),
      Bun.write(join(directory, `${mac}.sha256`), `${macDigest}  ${mac}\n`),
      Bun.write(join(directory, windows), 'windows archive'),
      Bun.write(join(directory, `${windows}.sha256`), `${windowsDigest} *nested/${windows}\n`),
      Bun.write(join(directory, 'monad-power-pack.atom-pack.zip'), 'power pack'),
      mkdir(join(directory, 'ignored-directory'))
    ]);

    expect([...(await readArchiveSha256s(directory))]).toEqual([
      [mac, macDigest],
      [windows, windowsDigest]
    ]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('archive checksum loading rejects a checksum bound to another asset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monad-archive-checksums-'));
  const archive = 'monad-aarch64-apple-darwin.tar.gz';
  try {
    await Bun.write(join(directory, archive), 'archive');
    await Bun.write(join(directory, `${archive}.sha256`), `${'c'.repeat(64)}  another.tar.gz\n`);

    await expect(readArchiveSha256s(directory)).rejects.toThrow(`invalid SHA-256 file for ${archive}`);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
