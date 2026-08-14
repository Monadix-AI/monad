import type { ManifestAtomPack } from '@monad/sdk-atom';

import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

function isManifestAtomPack(value: unknown): value is ManifestAtomPack {
  return (
    typeof value === 'object' &&
    value !== null &&
    'manifest' in value &&
    typeof (value as ManifestAtomPack).register === 'function' &&
    Array.isArray((value as ManifestAtomPack).manifest?.atoms)
  );
}

function contentIntegrity(bytes: Uint8Array): string {
  return `sha256-${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`;
}

async function materializeVersionedEntry(entryPath: string, bytes: Uint8Array, integrity: string): Promise<string> {
  const entryDir = dirname(entryPath);
  const prefix = `.${basename(entryPath)}.`;
  const filename = `${prefix}${integrity.slice('sha256-'.length)}.js`;
  const versionedPath = join(entryDir, filename);
  const entries = await readdir(entryDir);
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => rm(join(entryDir, entry), { recursive: true, force: true }))
  );
  await writeFile(versionedPath, bytes, { flag: 'wx', mode: 0o600 });
  return versionedPath;
}

export async function loadAtomPackEntry(entryPath: string, recordedIntegrity?: string): Promise<ManifestAtomPack> {
  const bytes = await readFile(entryPath);
  const integrity = contentIntegrity(bytes);
  if (recordedIntegrity && integrity !== recordedIntegrity) {
    throw new Error(`integrity mismatch — bundle changed since install (${integrity} ≠ ${recordedIntegrity})`);
  }

  const versionedEntryPath = await materializeVersionedEntry(entryPath, bytes, integrity);
  const module = (await import(pathToFileURL(versionedEntryPath).href)) as Record<string, unknown>;
  if (!isManifestAtomPack(module.default)) {
    throw new Error('entry must default-export a defineAtomPack() result');
  }
  return module.default;
}
