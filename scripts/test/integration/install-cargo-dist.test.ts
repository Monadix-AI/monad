import { expect, test } from 'bun:test';

import { installCargoDist } from '../../install-cargo-dist.ts';

const sha256 = (bytes: Uint8Array): string => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

test('cargo-dist installer executes only after its pinned checksum matches', async () => {
  const trusted = new TextEncoder().encode('#!/bin/sh\necho trusted\n');
  const substituted = new TextEncoder().encode('#!/bin/sh\necho substituted\n');
  const executed: string[] = [];
  const execute = async (path: string) => {
    executed.push(await Bun.file(path).text());
    return 0;
  };

  await expect(
    installCargoDist({
      version: '0.32.0',
      expectedSha256: sha256(trusted),
      download: async () => substituted,
      execute
    })
  ).rejects.toThrow('checksum mismatch');
  expect(executed).toEqual([]);

  await installCargoDist({
    version: '0.32.0',
    expectedSha256: sha256(trusted),
    download: async () => trusted,
    execute
  });
  expect(executed).toEqual(['#!/bin/sh\necho trusted\n']);
});
