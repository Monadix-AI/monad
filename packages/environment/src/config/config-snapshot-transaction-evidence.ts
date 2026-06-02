import type { ConfigSnapshotTransactionManifest } from './config-snapshot-transaction-artifacts.ts';
import type {
  ConfigSnapshotDocument,
  ConfigSnapshotTransactionLayout,
  ConfigSnapshotTransactionOptions
} from './config-snapshot-transaction-types.ts';

import { readdir, rename, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import {
  backupPath,
  claimPath,
  committedManifestPath,
  conflictManifestPath,
  isGeneratedTransactionId,
  parseManifest,
  readOptionalText,
  removeIfExists,
  replaceFile,
  retainedRollbackPath,
  syncParentDirectory,
  targetFor,
  writeSecureFile
} from './config-snapshot-transaction-artifacts.ts';

type SnapshotConflictReason =
  | 'claim-evidence-missing'
  | 'claimed-inode-modified'
  | 'deleted-before-claim'
  | 'target-created-before-claim'
  | 'target-replaced-after-claim'
  | 'target-replaced-before-claim';

export interface SnapshotConflict {
  name: ConfigSnapshotDocument;
  reason: SnapshotConflictReason;
}

const RETAINED_COMMITTED_TRANSACTION_LIMIT = 2;

export async function retainRollbackEvidence(target: string, transactionId: string): Promise<void> {
  const source = backupPath(target);
  const retained = retainedRollbackPath(target, transactionId);
  if ((await readOptionalText(source)) === null) return;
  if ((await readOptionalText(retained)) !== null) {
    await removeIfExists(source);
    return;
  }
  await rename(source, retained);
  await syncParentDirectory(target);
}

export async function writeConflictEvidence(
  manifestPath: string,
  manifest: ConfigSnapshotTransactionManifest,
  conflicts: SnapshotConflict[],
  options: ConfigSnapshotTransactionOptions
): Promise<void> {
  const path = conflictManifestPath(manifestPath, manifest.transactionId);
  const temp = `${path}.tmp`;
  const expected = { ...manifest, conflicts };
  const existing = await readOptionalText(path);
  if (existing !== null && matchesConflictEvidence(existing, expected)) {
    if (await removeIfExists(temp)) await syncParentDirectory(temp);
    await syncParentDirectory(path);
    await options.afterStep?.('conflict:directory-synced');
    return;
  }
  await writeSecureFile(temp, `${JSON.stringify(expected, null, 2)}\n`, async (suffix) => {
    await options.afterStep?.(suffix === 'directory-synced' ? 'conflict:temp-directory-synced' : `conflict:${suffix}`);
  });
  const staged = await readOptionalText(temp);
  if (staged === null || !matchesConflictEvidence(staged, expected)) {
    throw new Error('monad: invalid config snapshot conflict evidence');
  }
  await replaceFile(temp, path);
  await options.afterStep?.('conflict:installed');
  await syncParentDirectory(path);
  await options.afterStep?.('conflict:directory-synced');
}

export async function pruneCommittedEvidence(
  layout: ConfigSnapshotTransactionLayout,
  retainedTransactionId?: string
): Promise<void> {
  const directory = dirname(layout.manifestPath);
  const prefix = `${basename(committedManifestPath(layout.manifestPath))}-`;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const evidence = (
    await Promise.all(
      names.flatMap((name) => {
        if (!name.startsWith(prefix)) return [];
        const transactionId = name.slice(prefix.length);
        if (!isGeneratedTransactionId(transactionId)) return [];
        return [readCommittedEvidence(join(directory, name), transactionId, layout)];
      })
    )
  ).filter((entry) => entry !== null);
  const retained = evidence.filter(({ transactionId }) => transactionId === retainedTransactionId);
  const candidates = evidence
    .filter(({ transactionId }) => transactionId !== retainedTransactionId)
    .sort((left, right) => right.modifiedAt - left.modifiedAt || right.path.localeCompare(left.path));
  const keep = Math.max(0, RETAINED_COMMITTED_TRANSACTION_LIMIT - retained.length);
  for (const entry of candidates.slice(keep)) {
    if ((await readOptionalText(conflictManifestPath(layout.manifestPath, entry.transactionId))) !== null) continue;
    for (const document of entry.manifest.documents) {
      const target = targetFor(layout, document.name);
      await removeIfExists(claimPath(target, entry.transactionId));
      await removeIfExists(retainedRollbackPath(target, entry.transactionId));
      await syncParentDirectory(target);
    }
    await removeIfExists(entry.path);
    await syncParentDirectory(entry.path);
  }
}

async function readCommittedEvidence(
  path: string,
  transactionId: string,
  layout: ConfigSnapshotTransactionLayout
): Promise<{
  path: string;
  transactionId: string;
  modifiedAt: number;
  manifest: ConfigSnapshotTransactionManifest;
} | null> {
  const raw = await readOptionalText(path);
  if (raw === null) return null;
  let manifest: ConfigSnapshotTransactionManifest;
  try {
    manifest = parseManifest(raw, layout);
  } catch {
    return null;
  }
  if (manifest.phase !== 'committed' || manifest.transactionId !== transactionId) return null;
  const metadata = await stat(path);
  return { path, transactionId, modifiedAt: metadata.mtimeMs, manifest };
}

function matchesConflictEvidence(
  raw: string,
  expected: ConfigSnapshotTransactionManifest & { conflicts: SnapshotConflict[] }
): boolean {
  try {
    const manifest = parseManifest(raw);
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!Array.isArray(value.conflicts)) return false;
    const conflicts = value.conflicts.map((conflict) => {
      if (
        typeof conflict !== 'object' ||
        conflict === null ||
        Array.isArray(conflict) ||
        typeof (conflict as Record<string, unknown>).name !== 'string' ||
        typeof (conflict as Record<string, unknown>).reason !== 'string'
      ) {
        throw new Error('invalid conflict');
      }
      return {
        name: (conflict as Record<string, unknown>).name,
        reason: (conflict as Record<string, unknown>).reason
      };
    });
    return (
      JSON.stringify(manifest) === JSON.stringify(expectedManifest(expected)) &&
      JSON.stringify(conflicts) === JSON.stringify(expected.conflicts)
    );
  } catch {
    return false;
  }
}

function expectedManifest(
  evidence: ConfigSnapshotTransactionManifest & { conflicts: SnapshotConflict[] }
): ConfigSnapshotTransactionManifest {
  return {
    version: evidence.version,
    transactionId: evidence.transactionId,
    phase: evidence.phase,
    documents: evidence.documents
  };
}
