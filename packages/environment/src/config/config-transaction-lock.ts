import type { Pointer } from 'bun:ffi';

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { endianness, tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ConfigTransactionLockOptions {
  timeoutMs?: number;
}

export type ConfigTransactionLockIdentity =
  | { kind: 'system-v-semaphore'; key: number }
  | { kind: 'windows-global-mutex'; name: string };

interface UnixNativeLockLibrary {
  semget(key: number, count: number, flags: number): number;
  semop(id: number, operations: Pointer | null, count: number | bigint): number;
  semctl(id: number, index: number, command: number): number;
  errno(): Pointer | null;
  close(): void;
}

const IPC_CREAT = 0o1000;
const IPC_NOWAIT = 0o4000;
const SEM_UNDO = 0o10000;
const localLocks = new Map<string, Promise<void>>();

export async function withConfigTransactionLock<T>(
  homePath: string,
  run: () => Promise<T>,
  options: ConfigTransactionLockOptions = {}
): Promise<T> {
  const canonicalHome = await realpath(homePath);
  const timeoutMs = options.timeoutMs ?? 5_000;
  return withLocalLock(canonicalHome, timeoutMs, async (remainingMs) => {
    const identity = configTransactionLockIdentity(canonicalHome);
    if (identity.kind === 'windows-global-mutex') return withWindowsMutex(identity.name, run, remainingMs);
    return withUnixSemaphore(identity.key, run, remainingMs);
  });
}

export function configTransactionLockIdentity(
  canonicalHome: string,
  platform: NodeJS.Platform = process.platform,
  uid = process.getuid?.() ?? 0
): ConfigTransactionLockIdentity {
  const normalized = platform === 'win32' ? canonicalHome.replaceAll('\\', '/').toLowerCase() : canonicalHome;
  const digest = createHash('sha256')
    .update(platform === 'win32' ? normalized : `${uid}:${normalized}`)
    .digest();
  if (platform === 'win32') {
    return {
      kind: 'windows-global-mutex',
      name: `Global\\MonadConfigTransaction-${digest.toString('hex')}`
    };
  }
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error(`monad: config transaction lock is not supported on ${platform}`);
  }
  return { kind: 'system-v-semaphore', key: digest.readUInt32BE(0) & 0x7fff_ffff || 1 };
}

async function withUnixSemaphore<T>(key: number, run: () => Promise<T>, timeoutMs: number): Promise<T> {
  const { ptr, read } = await import('bun:ffi');
  const library = await openUnixNativeLockLibrary();
  let acquired = false;
  let result!: T;
  const errors: unknown[] = [];
  try {
    const semaphoreId = library.semget(key, 1, IPC_CREAT | 0o600);
    if (semaphoreId < 0) throw unixLockError('open', readUnixErrno(library, read.i32));
    const acquire = semaphoreOperations([
      { operation: 0, flags: IPC_NOWAIT },
      { operation: 1, flags: IPC_NOWAIT | SEM_UNDO }
    ]);
    const deadline = performance.now() + timeoutMs;
    while (library.semop(semaphoreId, ptr(acquire), 2) !== 0) {
      const errno = readUnixErrno(library, read.i32);
      if (errno !== busyErrno() && errno !== 4) throw unixLockError('acquire', errno);
      if (performance.now() >= deadline) throw lockTimeout(timeoutMs);
      await Bun.sleep(Math.min(10, Math.max(1, deadline - performance.now())));
    }
    acquired = true;
    try {
      result = await run();
    } catch (error) {
      errors.push(error);
    }
    if (acquired) {
      const release = semaphoreOperations([{ operation: -1, flags: IPC_NOWAIT | SEM_UNDO }]);
      let released = false;
      while (!released) {
        if (library.semop(semaphoreId, ptr(release), 1) === 0) {
          released = true;
          acquired = false;
          continue;
        }
        const errno = readUnixErrno(library, read.i32);
        if (errno !== 4) {
          errors.push(unixLockError('release', errno));
          break;
        }
      }
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    library.close();
  } catch (error) {
    errors.push(error);
  }
  throwCollected(errors);
  return result;
}

export async function removeConfigTransactionSemaphoreForTests(homePath: string): Promise<void> {
  if (process.platform === 'win32') return;
  const canonicalHome = await realpath(homePath);
  const identity = configTransactionLockIdentity(canonicalHome);
  if (identity.kind !== 'system-v-semaphore') return;
  const { ptr, read } = await import('bun:ffi');
  const library = await openUnixNativeLockLibrary();
  try {
    const semaphoreId = library.semget(identity.key, 1, 0o600);
    if (semaphoreId < 0) return;
    const acquire = semaphoreOperations([
      { operation: 0, flags: IPC_NOWAIT },
      { operation: 1, flags: IPC_NOWAIT | SEM_UNDO }
    ]);
    const deadline = performance.now() + 5_000;
    while (library.semop(semaphoreId, ptr(acquire), 2) !== 0) {
      const errno = readUnixErrno(library, read.i32);
      if (removedSemaphoreErrnos().includes(errno)) return;
      if (errno !== busyErrno() && errno !== 4) throw unixLockError('acquire', errno);
      if (performance.now() >= deadline) throw lockTimeout(5_000);
      await Bun.sleep(Math.min(10, Math.max(1, deadline - performance.now())));
    }
    if (library.semctl(semaphoreId, 0, 0) !== 0) {
      const errno = readUnixErrno(library, read.i32);
      if (!removedSemaphoreErrnos().includes(errno)) throw unixLockError('release', errno);
    }
  } finally {
    try {
      library.close();
    } catch {}
  }
}

async function openUnixNativeLockLibrary(): Promise<UnixNativeLockLibrary> {
  const { dlopen, FFIType } = await import('bun:ffi');
  const definitions = {
    semget: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    semop: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    semctl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 }
  } as const;
  if (process.platform === 'darwin') {
    const library = dlopen(resolveLibc(), {
      ...definitions,
      __error: { args: [], returns: FFIType.ptr }
    });
    return {
      semget: library.symbols.semget,
      semop: library.symbols.semop,
      semctl: library.symbols.semctl,
      errno: library.symbols.__error,
      close: () => library.close()
    };
  }
  const library = dlopen(resolveLibc(), {
    ...definitions,
    __errno_location: { args: [], returns: FFIType.ptr }
  });
  return {
    semget: library.symbols.semget,
    semop: library.symbols.semop,
    semctl: library.symbols.semctl,
    errno: library.symbols.__errno_location,
    close: () => library.close()
  };
}

async function withWindowsMutex<T>(name: string, run: () => Promise<T>, timeoutMs: number): Promise<T> {
  const digest = createHash('sha256').update(name).digest('hex');
  const lockPath = join(tmpdir(), `monad-config-transaction-${digest}.lock`);
  const token = randomUUID();
  const deadline = performance.now() + timeoutMs;
  while (true) {
    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, token }), { flag: 'wx' });
      break;
    } catch (error) {
      if (filesystemErrorCode(error) !== 'EEXIST') {
        throw new Error('monad: config transaction lock failed', { cause: error });
      }
      const owner = await readWindowsLockOwner(lockPath);
      if (owner && !processIsAlive(owner.pid)) {
        const stalePath = `${lockPath}.stale-${token}`;
        try {
          await rename(lockPath, stalePath);
          await rm(stalePath, { recursive: true, force: true });
          continue;
        } catch (staleError) {
          if (filesystemErrorCode(staleError) !== 'ENOENT' && filesystemErrorCode(staleError) !== 'EEXIST') {
            throw new Error('monad: config transaction stale lock cleanup failed', { cause: staleError });
          }
        }
      }
      if (performance.now() >= deadline) throw lockTimeout(timeoutMs);
      await Bun.sleep(Math.min(10, Math.max(1, deadline - performance.now())));
    }
  }
  let result!: T;
  const errors: unknown[] = [];
  try {
    result = await run();
  } catch (error) {
    errors.push(error);
  }
  try {
    const owner = await readWindowsLockOwner(lockPath);
    if (owner?.token !== token) throw new Error('monad: config transaction lock ownership changed before release');
    await rm(lockPath, { recursive: true });
  } catch (error) {
    errors.push(error);
  }
  throwCollected(errors);
  return result;
}

async function readWindowsLockOwner(lockPath: string): Promise<{ pid: number; token: string } | null> {
  try {
    const value = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as unknown;
    if (
      typeof value === 'object' &&
      value !== null &&
      'pid' in value &&
      Number.isInteger(value.pid) &&
      'token' in value &&
      typeof value.token === 'string'
    ) {
      return { pid: Number(value.pid), token: value.token };
    }
  } catch (error) {
    if (filesystemErrorCode(error) !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  return null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return filesystemErrorCode(error) === 'EPERM';
  }
}

function filesystemErrorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : undefined;
}

function semaphoreOperations(operations: Array<{ operation: number; flags: number }>): Buffer {
  const buffer = Buffer.alloc(operations.length * 6);
  const littleEndian = endianness() === 'LE';
  for (const [index, operation] of operations.entries()) {
    const offset = index * 6;
    if (littleEndian) {
      buffer.writeUInt16LE(0, offset);
      buffer.writeInt16LE(operation.operation, offset + 2);
      buffer.writeInt16LE(operation.flags, offset + 4);
    } else {
      buffer.writeUInt16BE(0, offset);
      buffer.writeInt16BE(operation.operation, offset + 2);
      buffer.writeInt16BE(operation.flags, offset + 4);
    }
  }
  return buffer;
}

function resolveLibc(): string {
  if (process.platform === 'darwin') return '/usr/lib/libSystem.B.dylib';
  if (process.platform !== 'linux') throw new Error(`monad: libc resolution not supported on ${process.platform}`);
  for (const line of readFileSync('/proc/self/maps', 'utf8').split('\n')) {
    const match = line.match(/(\/[^\s]+\/(libc\.so\.\d+|libc-[\d.]+\.so|ld-musl-[^\s]+\.so\.\d+))/);
    if (match?.[1]) return match[1];
  }
  throw new Error('monad: cannot locate libc in /proc/self/maps');
}

function busyErrno(): number {
  return process.platform === 'darwin' ? 35 : 11;
}

function removedSemaphoreErrnos(): readonly number[] {
  return process.platform === 'darwin' ? [22, 82] : [22, 43];
}

function unixLockError(operation: 'open' | 'acquire' | 'release', errno: number): Error {
  return new Error(`monad: config transaction semaphore ${operation} failed (${errno})`);
}

function lockTimeout(timeoutMs: number): Error {
  return new Error(`monad: config transaction lock timed out after ${timeoutMs}ms`);
}

async function withLocalLock<T>(key: string, timeoutMs: number, run: (remainingMs: number) => Promise<T>): Promise<T> {
  const previous = localLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  localLocks.set(key, tail);
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let entered = false;
  try {
    await Promise.race([
      previous,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(lockTimeout(timeoutMs)), timeoutMs);
      })
    ]);
    entered = true;
    if (timer !== undefined) clearTimeout(timer);
    return await run(Math.ceil(Math.max(0, timeoutMs - (performance.now() - startedAt))));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (entered) {
      release();
    } else {
      void previous.then(release);
    }
    void tail.then(() => {
      if (localLocks.get(key) === tail) localLocks.delete(key);
    });
  }
}

function readUnixErrno(library: UnixNativeLockLibrary, read: (pointer: Pointer) => number): number {
  const pointer = library.errno();
  if (pointer === null) return 0;
  return read(pointer);
}

function throwCollected(errors: unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'monad: config transaction lock failed');
}
