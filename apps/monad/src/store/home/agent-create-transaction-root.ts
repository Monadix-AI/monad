import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

export interface AnchoredDirectory {
  path: string;
  handle: FileHandle;
  dev: number;
  ino: number;
}

export interface AgentCreateTransactionRoot extends AnchoredDirectory {
  created: boolean;
}

const TRANSACTION_ROOT = '.create-transactions';
const ROOT_ERROR = 'monad: unsafe agent create transaction root';

export async function openAgentCreateTransactionRoot(
  agentsRoot: string,
  options: { create?: boolean; expectedOwnerUid?: number } = {}
): Promise<AgentCreateTransactionRoot | null> {
  if (options.create !== false) await mkdir(agentsRoot, { recursive: true });
  const path = join(agentsRoot, TRANSACTION_ROOT);
  const created = options.create === false ? false : await mkdirExclusive(path, 0o700);
  let directory: AnchoredDirectory;
  try {
    directory = await openAnchoredDirectory(path, {
      expectedOwnerUid: options.expectedOwnerUid,
      repairMode: 0o700,
      errorPrefix: ROOT_ERROR
    });
  } catch (error) {
    if (options.create === false && isMissing(error)) return null;
    throw error;
  }
  return { ...directory, created };
}

export async function ensureSecureAgentCreateTransactionRoot(
  agentsRoot: string,
  options: { expectedOwnerUid?: number; syncCreated?: boolean } = {}
): Promise<{ path: string; created: boolean }> {
  const root = await openAgentCreateTransactionRoot(agentsRoot, {
    expectedOwnerUid: options.expectedOwnerUid
  });
  if (root === null) throw new Error(`${ROOT_ERROR}: missing`);
  try {
    if (root.created && options.syncCreated !== false) await syncDirectory(agentsRoot);
    return { path: root.path, created: root.created };
  } finally {
    await root.handle.close();
  }
}

export async function openAnchoredDirectory(
  path: string,
  options: {
    expectedOwnerUid?: number;
    repairMode?: number;
    errorPrefix?: string;
  } = {}
): Promise<AnchoredDirectory> {
  const errorPrefix = options.errorPrefix ?? 'monad: unsafe anchored directory';
  const linkInfo = await lstat(path);
  if (linkInfo.isSymbolicLink()) throw new Error(`${errorPrefix}: symlink`);
  if (!linkInfo.isDirectory()) throw new Error(`${errorPrefix}: file`);
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw new Error(`${errorPrefix}: symlink`);
    if (code === 'ENOTDIR') throw new Error(`${errorPrefix}: file`);
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isDirectory()) throw new Error(`${errorPrefix}: file`);
    const expectedOwnerUid = options.expectedOwnerUid ?? process.getuid?.();
    if (expectedOwnerUid !== undefined && info.uid !== expectedOwnerUid) {
      throw new Error(`${errorPrefix}: owner`);
    }
    if (
      process.platform !== 'win32' &&
      options.repairMode !== undefined &&
      (info.mode & 0o777) !== options.repairMode
    ) {
      await handle.chmod(options.repairMode);
      const repaired = await handle.stat();
      if ((repaired.mode & 0o777) !== options.repairMode) throw new Error(`${errorPrefix}: mode`);
    }
    const directory = { path, handle, dev: info.dev, ino: info.ino };
    await assertAnchoredDirectory(directory, errorPrefix);
    return directory;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function assertAnchoredDirectory(directory: AnchoredDirectory, errorPrefix = ROOT_ERROR): Promise<void> {
  let current: Stats;
  try {
    current = await lstat(directory.path);
  } catch (error) {
    if (isMissing(error)) throw new Error(`${errorPrefix}: replaced`);
    throw error;
  }
  if (current.isSymbolicLink() || !current.isDirectory()) throw new Error(`${errorPrefix}: replaced`);
  const anchored = await directory.handle.stat();
  if (
    current.dev !== directory.dev ||
    current.ino !== directory.ino ||
    anchored.dev !== directory.dev ||
    anchored.ino !== directory.ino
  ) {
    throw new Error(`${errorPrefix}: replaced`);
  }
}

export async function isAnchoredDirectoryCurrent(directory: AnchoredDirectory): Promise<boolean> {
  try {
    await assertAnchoredDirectory(directory);
    return true;
  } catch {
    return false;
  }
}

export async function syncAnchoredDirectory(directory: AnchoredDirectory): Promise<void> {
  if (process.platform === 'win32') return;
  await directory.handle.sync();
}

async function mkdirExclusive(path: string, mode: number): Promise<boolean> {
  try {
    await mkdir(path, { mode });
    return true;
  } catch (error) {
    if (isAlreadyExists(error)) return false;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}
