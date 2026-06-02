import type {
  ConfigSnapshotDocument,
  ConfigSnapshotPhase,
  ConfigSnapshotTransactionDocument,
  ConfigSnapshotTransactionLayout,
  ConfigSnapshotTransactionOptions
} from './config-snapshot-transaction-types.ts';

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface ConfigSnapshotTransactionManifest {
  version: 2;
  transactionId: string;
  phase: ConfigSnapshotPhase;
  documents: Array<{
    name: ConfigSnapshotDocument;
    hadPrevious: boolean;
    previousSha256?: string;
    nextSha256: string;
  }>;
}

export async function writeManifest(
  manifestPath: string,
  manifest: ConfigSnapshotTransactionManifest,
  options: ConfigSnapshotTransactionOptions
): Promise<void> {
  const target = manifest.phase === 'committed' ? committedManifestPath(manifestPath) : manifestPath;
  const temp = `${target}.tmp`;
  const prefix = `manifest:${manifest.phase}` as const;
  await writeSecureFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, async (suffix) => {
    await options.afterStep?.(
      suffix === 'directory-synced' ? `${prefix}:temp-directory-synced` : `${prefix}:${suffix}`
    );
  });
  parseManifest(await readFile(temp, 'utf8'));
  await replaceFile(temp, target);
  await options.afterStep?.(`${prefix}:installed`);
  await syncParentDirectory(target);
  await options.afterStep?.(`${prefix}:directory-synced`);
}

export async function cleanupCommitted(
  layout: ConfigSnapshotTransactionLayout,
  manifest: ConfigSnapshotTransactionManifest,
  options: ConfigSnapshotTransactionOptions
): Promise<void> {
  for (const entry of manifest.documents) {
    const target = targetFor(layout, entry.name);
    const removed = await Promise.all([removeIfExists(backupPath(target)), removeIfExists(stagedPath(target))]);
    if (removed.some(Boolean)) await options.afterStep?.(`cleanup:${entry.name}:removed`);
    await syncParentDirectory(target);
    await options.afterStep?.(`cleanup:${entry.name}:directory-synced`);
  }
  const preparedPath = layout.manifestPath;
  const removedPrepared = await removeIfExists(preparedPath);
  await removeIfExists(`${layout.manifestPath}.tmp`);
  if (removedPrepared) {
    await options.afterStep?.('cleanup:manifest:prepared-removed');
    await syncParentDirectory(preparedPath);
    await options.afterStep?.('cleanup:manifest:prepared-directory-synced');
  }
  const committedPath = committedManifestPath(layout.manifestPath);
  const removedCommitted = await archiveCommittedManifest(committedPath, manifest.transactionId);
  await removeIfExists(`${committedPath}.tmp`);
  if (removedCommitted) {
    await options.afterStep?.('cleanup:manifest:committed-removed');
    await syncParentDirectory(committedPath);
    await options.afterStep?.('cleanup:manifest:committed-directory-synced');
  }
}

export async function cleanupOrphans(
  layout: ConfigSnapshotTransactionLayout,
  options: ConfigSnapshotTransactionOptions
): Promise<void> {
  await cleanupRecoveryArtifacts(layout.documents, options);
  await cleanupRecoveryManifests(layout.manifestPath, options);
}

export async function cleanupRecoveryArtifacts(
  documents: Array<Pick<ConfigSnapshotTransactionDocument, 'name' | 'target'>>,
  options: ConfigSnapshotTransactionOptions
): Promise<void> {
  for (const { name, target } of documents) {
    if (await removeIfExists(stagedPath(target))) await options.afterStep?.(`recovery:${name}:stage-removed`);
    await syncParentDirectory(target);
    await options.afterStep?.(`recovery:${name}:stage-directory-synced`);
    if (await removeIfExists(backupPath(target))) await options.afterStep?.(`recovery:${name}:backup-removed`);
    await syncParentDirectory(target);
    await options.afterStep?.(`recovery:${name}:backup-directory-synced`);
  }
}

export async function cleanupRecoveryManifests(
  manifestPath: string,
  options: ConfigSnapshotTransactionOptions,
  manifest?: ConfigSnapshotTransactionManifest
): Promise<void> {
  const committedPath = committedManifestPath(manifestPath);
  for (const [phase, path] of [
    ['prepared', `${manifestPath}.tmp`],
    ['committed', `${committedPath}.tmp`]
  ] as const) {
    if (await removeIfExists(path)) await options.afterStep?.(`recovery:manifest:${phase}-temp-removed`);
    await syncParentDirectory(path);
    await options.afterStep?.(`recovery:manifest:${phase}-temp-directory-synced`);
  }
  for (const [phase, path] of [
    ['prepared', manifestPath],
    ['committed', committedPath]
  ] as const) {
    const removed =
      phase === 'committed' && manifest?.phase === 'committed'
        ? await archiveCommittedManifest(path, manifest.transactionId)
        : await removeIfExists(path);
    if (removed) await options.afterStep?.(`recovery:manifest:${phase}-removed`);
    await syncParentDirectory(path);
    await options.afterStep?.(`recovery:manifest:${phase}-directory-synced`);
  }
}

export async function writeSecureFile(
  filePath: string,
  content: string,
  afterStep: (suffix: 'created-secure' | 'written' | 'synced' | 'directory-synced') => void | Promise<void> = () => {}
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await removeIfExists(filePath);
  const handle = await open(filePath, 'wx', 0o600);
  try {
    await afterStep('created-secure');
    await handle.writeFile(content);
    await afterStep('written');
    await handle.sync();
    await afterStep('synced');
  } finally {
    await handle.close();
  }
  await syncParentDirectory(filePath);
  await afterStep('directory-synced');
}

export async function replaceFile(source: string, target: string): Promise<void> {
  if (process.platform === 'win32') await removeIfExists(target);
  await rename(source, target);
}

export async function syncParentDirectory(filePath: string): Promise<void> {
  if (process.platform === 'win32') return;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(dirname(filePath), 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function parseManifest(
  raw: string,
  layout?: ConfigSnapshotTransactionLayout
): ConfigSnapshotTransactionManifest {
  const value = JSON.parse(raw) as unknown;
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    typeof value.transactionId !== 'string' ||
    !isGeneratedTransactionId(value.transactionId) ||
    (value.phase !== 'prepared' && value.phase !== 'committed')
  ) {
    throw new Error('monad: invalid config snapshot recovery manifest');
  }
  if (!Array.isArray(value.documents)) throw new Error('monad: invalid config snapshot recovery manifest');
  const allowed = new Set(layout?.documents.map(({ name }) => name) ?? ['config', 'agents', 'mesh', 'auth']);
  const documents = value.documents.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.hadPrevious !== 'boolean' ||
      typeof entry.name !== 'string' ||
      !allowed.has(entry.name as ConfigSnapshotDocument) ||
      (entry.hadPrevious && typeof entry.previousSha256 !== 'string') ||
      typeof entry.nextSha256 !== 'string'
    ) {
      throw new Error('monad: invalid config snapshot recovery manifest');
    }
    return {
      name: entry.name as ConfigSnapshotDocument,
      hadPrevious: entry.hadPrevious,
      ...(entry.hadPrevious ? { previousSha256: entry.previousSha256 as string } : {}),
      nextSha256: entry.nextSha256
    };
  });
  if (new Set(documents.map(({ name }) => name)).size !== documents.length) {
    throw new Error('monad: invalid config snapshot recovery manifest');
  }
  return { version: 2, transactionId: value.transactionId, phase: value.phase, documents };
}

export function isGeneratedTransactionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function targetFor(layout: ConfigSnapshotTransactionLayout, name: ConfigSnapshotDocument): string {
  const target = layout.documents.find((document) => document.name === name)?.target;
  if (!target) throw new Error(`monad: unknown config snapshot document: ${name}`);
  return target;
}

export function stagedPath(target: string): string {
  return `${target}.snapshot-next`;
}

export function backupPath(target: string): string {
  return `${target}.snapshot-previous`;
}

export function claimPath(target: string, transactionId: string): string {
  return `${target}.snapshot-claim-${transactionId}`;
}

export function committedManifestPath(manifestPath: string): string {
  return `${manifestPath}.committed`;
}

export async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

export async function removeIfExists(filePath: string): Promise<boolean> {
  try {
    await unlink(filePath);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function isMissingFile(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}

async function archiveCommittedManifest(path: string, transactionId: string): Promise<boolean> {
  if ((await readOptionalText(path)) === null) return false;
  const archive = `${path}-${transactionId}`;
  if ((await readOptionalText(archive)) !== null) {
    await removeIfExists(path);
    return true;
  }
  await rename(path, archive);
  return true;
}

export function retainedRollbackPath(target: string, transactionId: string): string {
  return `${target}.snapshot-rollback-${transactionId}`;
}

export function conflictManifestPath(manifestPath: string, transactionId: string): string {
  return `${manifestPath}.conflicted-${transactionId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
