import type { ConfigSnapshotTransactionManifest } from './config-snapshot-transaction-artifacts.ts';
import type {
  ConfigSnapshotDocument,
  ConfigSnapshotTransactionDocument,
  ConfigSnapshotTransactionLayout,
  ConfigSnapshotTransactionOptions
} from './config-snapshot-transaction-types.ts';

import { randomUUID } from 'node:crypto';
import { link, readFile, rename, unlink } from 'node:fs/promises';

import {
  backupPath,
  claimPath,
  cleanupCommitted,
  cleanupOrphans,
  cleanupRecoveryArtifacts,
  cleanupRecoveryManifests,
  committedManifestPath,
  isAlreadyExists,
  isMissingFile,
  parseManifest,
  readOptionalText,
  removeIfExists,
  replaceFile,
  sha256,
  stagedPath,
  syncParentDirectory,
  targetFor,
  writeManifest,
  writeSecureFile
} from './config-snapshot-transaction-artifacts.ts';
import {
  pruneCommittedEvidence,
  retainRollbackEvidence,
  type SnapshotConflict,
  writeConflictEvidence
} from './config-snapshot-transaction-evidence.ts';
import { withConfigTransactionLock } from './config-transaction-lock.ts';

export type {
  ConfigSnapshotDocument,
  ConfigSnapshotTransactionOptions,
  ConfigSnapshotTransactionStep
} from './config-snapshot-transaction-types.ts';

export async function saveConfigSnapshotTransaction(
  layout: ConfigSnapshotTransactionLayout,
  documents: ConfigSnapshotTransactionDocument[],
  options: ConfigSnapshotTransactionOptions = {}
): Promise<void> {
  await withConfigTransactionLock(layout.home, async () => {
    await recoverUnlocked(layout);
    if (documents.length === 0) return;

    const actualPrevious = new Map<ConfigSnapshotDocument, string | null>();
    for (const document of documents) {
      const actual = await readOptionalText(document.target);
      if (!sameDocumentState(document, actual, document.previousContent)) {
        throw new Error(`monad: snapshot transaction conflict: ${document.name}`);
      }
      actualPrevious.set(document.name, actual);
    }

    const manifest: ConfigSnapshotTransactionManifest = {
      version: 2,
      transactionId: randomUUID(),
      phase: 'prepared',
      documents: documents.map(({ name, nextContent }) => {
        const actual = actualPrevious.get(name) ?? null;
        return {
          name,
          hadPrevious: actual !== null,
          ...(actual === null ? {} : { previousSha256: sha256(actual) }),
          nextSha256: sha256(nextContent)
        };
      })
    };

    try {
      for (const document of documents) {
        await writeSecureFile(stagedPath(document.target), document.nextContent, (suffix) =>
          options.afterStep?.(`stage:${document.name}:${suffix}`)
        );
        document.normalize(await readFile(stagedPath(document.target), 'utf8'));
      }
      for (const document of documents) {
        const previous = actualPrevious.get(document.name) ?? null;
        if (previous === null) continue;
        await writeSecureFile(backupPath(document.target), previous, (suffix) =>
          options.afterStep?.(`rollback:${document.name}:${suffix}`)
        );
        if (sha256(await readFile(backupPath(document.target), 'utf8')) !== sha256(previous)) {
          throw new Error(`monad: snapshot transaction rollback evidence mismatch: ${document.name}`);
        }
      }
      for (const document of documents) {
        const actual = await readOptionalText(document.target);
        if (!sameDocumentState(document, actual, document.previousContent)) {
          throw new Error(`monad: snapshot transaction conflict: ${document.name}`);
        }
        await options.afterStep?.(`check:${document.name}:final`);
      }

      await writeManifest(layout.manifestPath, manifest, options);
      for (const document of documents) {
        const previous = actualPrevious.get(document.name) ?? null;
        if (previous !== null) {
          try {
            await rename(document.target, claimPath(document.target, manifest.transactionId));
          } catch (error) {
            if (isMissingFile(error)) throw new Error(`monad: snapshot transaction conflict: ${document.name}`);
            throw error;
          }
          await options.afterStep?.(`claim:${document.name}:renamed`);
          await syncParentDirectory(document.target);
          await options.afterStep?.(`claim:${document.name}:directory-synced`);
          const claimed = await readOptionalText(claimPath(document.target, manifest.transactionId));
          if (claimed === null || sha256(claimed) !== sha256(previous)) {
            throw new Error(`monad: snapshot transaction conflict: ${document.name}`);
          }
        } else if ((await readOptionalText(document.target)) !== null) {
          throw new Error(`monad: snapshot transaction conflict: ${document.name}`);
        }
        await options.afterStep?.(`check:${document.name}:claimed`);
      }
      await revalidateClaims(documents, manifest, 'retained', options);
      for (const document of documents) {
        try {
          await link(stagedPath(document.target), document.target);
        } catch (error) {
          if (isAlreadyExists(error)) throw new Error(`monad: snapshot transaction conflict: ${document.name}`);
          throw error;
        }
        await options.afterStep?.(`install:${document.name}:linked`);
        await unlink(stagedPath(document.target));
        await options.afterStep?.(`install:${document.name}:stage-removed`);
        await syncParentDirectory(document.target);
        await options.afterStep?.(`install:${document.name}:directory-synced`);
      }
      await revalidateClaims(documents, manifest, 'precommit', options);
      await writeManifest(layout.manifestPath, { ...manifest, phase: 'committed' }, options);
      await cleanupCommitted(layout, manifest, options);
      await pruneCommittedEvidence(layout, manifest.transactionId);
    } catch (error) {
      if (options.recoverOnFailure !== false) await recoverUnlocked(layout).catch(() => {});
      throw error;
    }
  });
}

export async function recoverConfigSnapshotTransaction(
  layout: ConfigSnapshotTransactionLayout,
  options: ConfigSnapshotTransactionOptions = {}
): Promise<void> {
  await withConfigTransactionLock(layout.home, () => recoverUnlocked(layout, options));
}

export async function secureAtomicWrite(filePath: string, content: string): Promise<void> {
  const temp = `${filePath}.tmp`;
  await writeSecureFile(temp, content);
  await replaceFile(temp, filePath);
  await syncParentDirectory(filePath);
}

async function revalidateClaims(
  documents: ConfigSnapshotTransactionDocument[],
  manifest: ConfigSnapshotTransactionManifest,
  checkpoint: 'retained' | 'precommit',
  options: ConfigSnapshotTransactionOptions
): Promise<void> {
  for (const document of documents) {
    const entry = manifest.documents.find(({ name }) => name === document.name);
    if (!entry?.hadPrevious) continue;
    const claimed = await readOptionalText(claimPath(document.target, manifest.transactionId));
    if (claimed === null || sha256(claimed) !== entry.previousSha256) {
      throw new Error(`monad: snapshot transaction conflict: ${document.name}`);
    }
    await options.afterStep?.(`check:${document.name}:${checkpoint}`);
  }
}

async function recoverUnlocked(
  layout: ConfigSnapshotTransactionLayout,
  options: ConfigSnapshotTransactionOptions = {}
): Promise<void> {
  const committedRaw = await readOptionalText(committedManifestPath(layout.manifestPath));
  const manifestRaw = committedRaw ?? (await readOptionalText(layout.manifestPath));
  if (manifestRaw === null) {
    await cleanupOrphans(layout, options);
    await pruneCommittedEvidence(layout);
    return;
  }
  const manifest = parseManifest(manifestRaw, layout);
  if (committedRaw !== null && manifest.phase !== 'committed') {
    throw new Error('monad: invalid config snapshot recovery manifest');
  }
  const conflicts: SnapshotConflict[] = [];
  if (manifest.phase === 'prepared') {
    for (const entry of manifest.documents) {
      const target = targetFor(layout, entry.name);
      const backup = backupPath(target);
      const claim = claimPath(target, manifest.transactionId);
      const current = await readOptionalText(target);
      if (entry.hadPrevious) {
        const expectedPreviousSha256 = entry.previousSha256 as string;
        const previous = await readOptionalText(backup);
        const claimed = await readOptionalText(claim);
        if (claimed !== null) {
          const claimChanged = sha256(claimed) !== expectedPreviousSha256;
          if (current === null || sha256(current) === entry.nextSha256) {
            if (current !== null) await removeIfExists(target);
            if (claimChanged) {
              if (previous === null || sha256(previous) !== expectedPreviousSha256) {
                throw new Error(`monad: snapshot recovery rollback evidence missing: ${entry.name}`);
              }
              await rename(backup, target);
              conflicts.push({ name: entry.name, reason: 'claimed-inode-modified' });
            } else {
              await rename(claim, target);
            }
            await options.afterStep?.(`recovery:${entry.name}:target-restored`);
          } else {
            conflicts.push({ name: entry.name, reason: 'target-replaced-after-claim' });
          }
        } else if (current === null) {
          conflicts.push({ name: entry.name, reason: 'deleted-before-claim' });
        } else if (sha256(current) === entry.nextSha256) {
          await removeIfExists(target);
          conflicts.push({ name: entry.name, reason: 'claim-evidence-missing' });
        } else if (sha256(current) !== expectedPreviousSha256) {
          conflicts.push({ name: entry.name, reason: 'target-replaced-before-claim' });
        }
      } else if (current !== null && sha256(current) === entry.nextSha256 && (await removeIfExists(target))) {
        await options.afterStep?.(`recovery:${entry.name}:target-removed`);
      } else if (current !== null) {
        conflicts.push({ name: entry.name, reason: 'target-created-before-claim' });
      }
      if (conflicts.some(({ name }) => name === entry.name)) {
        await retainRollbackEvidence(target, manifest.transactionId);
      }
      await syncParentDirectory(target);
      await options.afterStep?.(`recovery:${entry.name}:target-directory-synced`);
    }
  }
  if (conflicts.length > 0) await writeConflictEvidence(layout.manifestPath, manifest, conflicts, options);
  await cleanupRecoveryArtifacts(
    manifest.documents.map(({ name }) => ({ name, target: targetFor(layout, name) })),
    options
  );
  await cleanupRecoveryManifests(layout.manifestPath, options, manifest);
  await pruneCommittedEvidence(layout, manifest.phase === 'committed' ? manifest.transactionId : undefined);
}

function sameDocumentState(
  document: ConfigSnapshotTransactionDocument,
  actual: string | null,
  expected: string | null
): boolean {
  if (actual === null || expected === null) return actual === expected;
  try {
    return document.normalize(actual) === document.normalize(expected);
  } catch {
    return false;
  }
}
