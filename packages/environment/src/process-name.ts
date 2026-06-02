import { accessSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';

/** Every long-lived process the daemon self-execs. Each gets a distinct sibling binary name next
 *  to the release `monad`/`monad.exe` executable, so `ps`/Activity Monitor/Task Manager show which
 *  role a process is instead of a wall of identical "monad" entries. */
export const MONAD_PROCESS_ROLES = ['daemon', 'restart', 'watchdog'] as const;
export type MonadProcessRole = (typeof MONAD_PROCESS_ROLES)[number];

/** Resolve the role-named sibling of a release binary (e.g. `bin/monad-daemon` next to
 *  `bin/monad`) for use as argv[0] of a self-exec spawn. The OS derives the process name shown in
 *  `ps`/Activity Monitor/Task Manager from the executed file's own path, not from argv or
 *  `process.title` — so distinguishing process names requires distinct files on disk; this resolves
 *  to the pre-built sibling created by `scripts/build-release.ts`. Role names stay short (`monad-`
 *  prefix + suffix well under 15 chars) because `ps -o comm=`/`top` truncate the kernel-reported
 *  process name at TASK_COMM_LEN (16 on macOS/BSD incl. NUL, 15 usable on Linux).
 *
 *  Falls back to `execPath` unchanged when the sibling isn't there or isn't executable (matches
 *  the check `findNativeLauncherBin` uses for the same class of adjacent-binary lookup): dev runs
 *  (`bun run`, no compiled binary), an install that predates this, a corrupted/partial install, or
 *  Windows, where the release build does not create siblings (no unprivileged same-volume symlink
 *  — bloating install size with full copies for a cosmetic-only feature there isn't worth it). */
export function roleExecPath(
  execPath: string,
  role: MonadProcessRole,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') return execPath;
  const named = join(dirname(execPath), `monad-${role}`);
  try {
    accessSync(named, constants.X_OK);
    return named;
  } catch {
    return execPath;
  }
}
