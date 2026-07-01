import { renameSync, statSync } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { debugLogDir, isDebugLogFileName, isDeveloperLogFileName } from '@monad/logger/log-files';

// On-disk log lifecycle. The @monad/logger package owns WHAT it writes and WHERE (it exports the
// directory + filename matchers); the daemon owns WHEN and HOW to reclaim that space. These bounds
// mirror the daemon's other retention constants (see store.pruneOldAcpDelegates' 7-day window)
// rather than living in config.json — operational limits, not user-facing knobs. Best-effort
// throughout: a stat/rename/unlink failure leaves the file as-is; an oversized log that keeps being
// written to beats crashing startup over log hygiene.

/** daemon.log is rotated when it grows past this. Its fd is inherited (opened by the CLI, handed to
 *  the detached daemon as stderr), so it can only be rotated at the open boundary — startup. */
export const DAEMON_LOG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
/** How many rotated daemon.log.N generations to keep (daemon.log.1 .. daemon.log.KEEP). */
export const DAEMON_LOG_KEEP = 5;
/** Age past which the daily temp-dir debug logs and per-session developer jsonl are swept. */
export const STALE_LOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * Ring-rotate a size-capped append log at its open boundary. If `path` is at/over `maxBytes`,
 * cascade the ring (the oldest, path.`keep`, is overwritten; path.i → path.(i+1); path → path.1)
 * so the caller reopens a fresh, empty `path`. Returns true iff a rotation happened. Sync so it can
 * run right before an `openSync(path, 'a')`. Any fs error is swallowed — the log is left untouched.
 */
export function rotateLogFile(path: string, opts: { maxBytes: number; keep: number }): boolean {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return false; // no log yet (or unreadable) — nothing to rotate
  }
  if (size < opts.maxBytes) return false;
  try {
    // Cascade newest-shifting-into-oldest so path.1 is freed. renameSync overwrites an existing
    // target on every platform (POSIX rename(2); Windows MoveFileEx REPLACE_EXISTING via libuv), so
    // the oldest generation (path.keep) is dropped implicitly by the i=keep-1 step.
    for (let i = opts.keep - 1; i >= 1; i--) {
      try {
        renameSync(`${path}.${i}`, `${path}.${i + 1}`);
      } catch {
        // that generation doesn't exist yet — skip it
      }
    }
    renameSync(path, `${path}.1`);
    return true;
  } catch {
    return false;
  }
}

/** Rotate ~/.monad/logs/daemon.log per the daemon-log policy. Call before opening it for append. */
export function rotateDaemonLog(logPath: string): boolean {
  return rotateLogFile(logPath, { maxBytes: DAEMON_LOG_MAX_BYTES, keep: DAEMON_LOG_KEEP });
}

/** Delete entries of `dir` accepted by `match` whose mtime is older than `maxAgeMs`. Best-effort;
 *  returns the count removed. An in-progress file (e.g. a live session's jsonl) has a recent mtime,
 *  so it is never swept while active. */
async function sweepDir(dir: string, match: (name: string) => boolean, maxAgeMs: number, now: number): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0; // dir doesn't exist yet
  }
  let removed = 0;
  for (const name of entries) {
    if (!match(name)) continue;
    const full = join(dir, name);
    try {
      const s = await stat(full);
      if (now - s.mtimeMs > maxAgeMs) {
        await unlink(full);
        removed++;
      }
    } catch {
      // vanished or unreadable — skip
    }
  }
  return removed;
}

/**
 * Sweep stale logs the daemon owns end to end: the daily `monad-debug-<date>.log` files in the OS
 * temp dir and the per-session/channel developer `*.jsonl` under `logsDir`. Which files those are
 * is decided by @monad/logger (via its exported matchers), not duplicated here. Bounded purely by
 * age (mtime) so active files survive. Returns the number of files removed. (daemon.log.N
 * generations are bounded by rotation, not this sweep.)
 */
export async function sweepStaleLogs(opts: {
  logsDir: string;
  tempDir?: string;
  maxAgeMs?: number;
  now?: number;
}): Promise<number> {
  const maxAgeMs = opts.maxAgeMs ?? STALE_LOG_MAX_AGE_MS;
  const now = opts.now ?? Date.now();
  const [debug, dev] = await Promise.all([
    sweepDir(opts.tempDir ?? debugLogDir, isDebugLogFileName, maxAgeMs, now),
    sweepDir(opts.logsDir, isDeveloperLogFileName, maxAgeMs, now)
  ]);
  return debug + dev;
}
