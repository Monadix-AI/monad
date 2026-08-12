import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { isPlatformReleaseArchive } from './public-release-assets.ts';

const SHA256_FILE = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i;

export async function readArchiveSha256s(directory: string): Promise<Map<string, string>> {
  const digests = new Map<string, string>();
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && isPlatformReleaseArchive(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    const checksum = await readFile(join(directory, `${name}.sha256`), 'utf8');
    const match = checksum.match(SHA256_FILE);
    if (!match || basename(match[2] ?? '') !== name) throw new Error(`invalid SHA-256 file for ${name}`);
    digests.set(name, (match[1] ?? '').toLowerCase());
  }
  if (digests.size === 0) throw new Error('no platform archive SHA-256 files found');
  return digests;
}
