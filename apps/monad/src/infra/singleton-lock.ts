import type { StrictTranslateForNamespace } from '@monad/i18n';

import { openSync, readFileSync, unlinkSync } from 'node:fs';

type DaemonTranslate = StrictTranslateForNamespace<'daemon'>;

class AlreadyRunningError extends Error {
  constructor(t: DaemonTranslate) {
    super(t('daemon.singleton.alreadyRunning'));
    this.name = 'AlreadyRunningError';
  }
}

/**
 * Acquires a process-lifetime OS lock so exactly one monad daemon can run per user account,
 * regardless of MONAD_HOME, port, or working directory.
 *
 * Unix    — open(path) + flock(LOCK_EX|LOCK_NB) via bun:ffi. The kernel releases the lock
 *           when the open file description closes — on any exit, including SIGKILL.
 * Windows — CreateMutexA("Local\\MonadDaemonSingleton") via kernel32. The kernel releases
 *           the named mutex when the process exits for any reason, including force-kill.
 * Fallback — PID-file probe when bun:ffi is unavailable (unusual environments only).
 */
export async function acquireSingletonLock(t: DaemonTranslate, lockPath: string): Promise<void> {
  try {
    if (process.platform === 'win32') {
      await acquireWindowsMutex(t);
    } else {
      await acquireUnixFlock(t, lockPath);
    }
  } catch (err) {
    // Re-throw the "already running" sentinel; degrade to PID probe on any FFI error.
    if (err instanceof AlreadyRunningError) throw err;
    await acquirePidFallback(t, lockPath);
  }
}

const LOCK_EX = 2;
const LOCK_NB = 4;

async function acquireUnixFlock(t: DaemonTranslate, lockPath: string): Promise<void> {
  const { dlopen, FFIType } = await import('bun:ffi');
  const { symbols } = dlopen(resolveLibc(), {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 }
  });

  // Open or create without truncating — we must not clear existing content before
  // we know we own the lock (another process wrote its PID there).
  const fd = openSync(lockPath, 'a');

  if (symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) throw new AlreadyRunningError(t);

  // Stamp our PID for diagnostics only — flock, not this value, is the actual lock.
  await Bun.write(lockPath, String(process.pid));

  // Keep `fd` open for the process lifetime. The flock is bound to this open file
  // description and is released by the kernel when the fd closes — on any exit,
  // including SIGKILL (no cleanup code needed for the lock itself).
  process.on('exit', () => {
    try {
      unlinkSync(lockPath);
    } catch {}
  });
}

/**
 * Locate the in-process libc via /proc/self/maps — works for glibc and musl on any
 * architecture (the path reflects whatever libc the Bun binary was loaded against).
 */
function resolveLibc(): string {
  if (process.platform === 'darwin') return '/usr/lib/libSystem.B.dylib';
  if (process.platform !== 'linux') throw new Error(`monad: libc resolution not supported on ${process.platform}`);

  const maps = readFileSync('/proc/self/maps', 'utf8');
  for (const line of maps.split('\n')) {
    // Matches paths such as:
    //   /lib/x86_64-linux-gnu/libc.so.6       (glibc, Debian/Ubuntu)
    //   /lib64/libc.so.6                       (glibc, RHEL/Fedora)
    //   /lib/libc-2.35.so                      (glibc, some distros)
    //   /lib/ld-musl-x86_64.so.1              (musl, Alpine x86_64)
    //   /lib/ld-musl-aarch64.so.1             (musl, Alpine ARM64)
    const m = line.match(/(\/[^\s]+\/(libc\.so\.\d+|libc-[\d.]+\.so|ld-musl-[^\s]+\.so\.\d+))/);
    if (m?.[1]) return m[1];
  }
  throw new Error('monad: cannot locate libc in /proc/self/maps');
}

// "Local\\" scope = per-logon-session (adequate for a desktop daemon; "Global\\" would
// require SeCreateGlobalPrivilege and is unnecessary for a single-user tool).
const MUTEX_NAME = 'Local\\MonadDaemonSingleton';
const ERROR_ALREADY_EXISTS = 183;

async function acquireWindowsMutex(t: DaemonTranslate): Promise<void> {
  const { dlopen, FFIType, ptr } = await import('bun:ffi');
  const { symbols } = dlopen('kernel32', {
    // HANDLE CreateMutexA(LPSECURITY_ATTRIBUTES, BOOL bInitialOwner, LPCSTR lpName)
    CreateMutexA: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
    GetLastError: { args: [], returns: FFIType.u32 }
  });

  const name = Buffer.from(`${MUTEX_NAME}\0`, 'ascii');
  symbols.CreateMutexA(null, 1, ptr(name));

  // ERROR_ALREADY_EXISTS means another process already owns the mutex.
  // Any other GetLastError value means we successfully created (and own) it.
  if (symbols.GetLastError() === ERROR_ALREADY_EXISTS) throw new AlreadyRunningError(t);

  // The HANDLE is a kernel object that lives for the process lifetime — no GC concern and
  // no explicit CloseHandle needed. Windows releases it automatically on any exit.
}

async function acquirePidFallback(t: DaemonTranslate, lockPath: string): Promise<void> {
  const text = await Bun.file(lockPath)
    .text()
    .catch(() => '');
  const pid = parseInt(text.trim(), 10);
  if (!Number.isNaN(pid)) {
    try {
      process.kill(pid, 0);
      throw new AlreadyRunningError(t);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
    }
  }
  await Bun.write(lockPath, String(process.pid));
  process.on('exit', () => {
    try {
      unlinkSync(lockPath);
    } catch {}
  });
}
