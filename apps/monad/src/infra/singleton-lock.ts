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
const WAIT_TIMEOUT = 0x0000_0102;

async function acquireWindowsMutex(t: DaemonTranslate): Promise<void> {
  const { dlopen, FFIType, ptr } = await import('bun:ffi');
  const { symbols } = dlopen('kernel32', {
    // HANDLE CreateMutexA(LPSECURITY_ATTRIBUTES, BOOL bInitialOwner, LPCSTR lpName)
    CreateMutexA: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
    // DWORD WaitForSingleObject(HANDLE, DWORD dwMilliseconds)
    WaitForSingleObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 }
  });

  const name = Buffer.from(`${MUTEX_NAME}\0`, 'ascii');

  // Acquire ownership of the named mutex — atomic and race-free without reading GetLastError.
  // Both concurrent starters' CreateMutexA calls resolve (in the kernel) to the SAME mutex object;
  // WaitForSingleObject(0) then grants ownership to exactly ONE of them (WAIT_OBJECT_0) and returns
  // WAIT_TIMEOUT to every other. We deliberately avoid the CreateMutexA+ERROR_ALREADY_EXISTS idiom:
  // bun:ffi can interleave its own Win32 calls between CreateMutexA and a GetLastError read, clobbering
  // the thread's last-error. WaitForSingleObject reports the result in its return value, so there is no
  // last-error dependency and no detect-then-create TOCTOU window.
  const handle = symbols.CreateMutexA(null, 0, ptr(name));
  if (!handle) throw new Error('monad: CreateMutexA failed'); // FFI failure → degrade to PID probe
  // WAIT_OBJECT_0 (0) or WAIT_ABANDONED (0x80, prior owner died) both mean we now hold it. Only
  // WAIT_TIMEOUT means another live process owns it. Hold the HANDLE for our process lifetime — the
  // kernel releases the mutex on any exit (including force-kill), so no ReleaseMutex/CloseHandle.
  if (symbols.WaitForSingleObject(handle, 0) === WAIT_TIMEOUT) {
    symbols.CloseHandle(handle);
    throw new AlreadyRunningError(t);
  }
}

async function acquirePidFallback(t: DaemonTranslate, lockPath: string): Promise<void> {
  const text = await Bun.file(lockPath)
    .text()
    .catch(() => '');
  const pid = parseInt(text.trim(), 10);
  // Skip our OWN pid: `monad start` writes the spawned daemon's pid into this same file BEFORE the
  // daemon acquires the lock, so the daemon would otherwise read its own (alive) pid and falsely
  // refuse to start. Only another live process's pid means a real prior instance. (This fallback is
  // hit on Windows, where the bun:ffi mutex path can throw and degrade to here.)
  if (!Number.isNaN(pid) && pid !== process.pid) {
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
