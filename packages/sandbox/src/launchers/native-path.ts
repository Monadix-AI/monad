// Shared native-launcher binary resolution for the Linux (Landlock) and Windows (Low-Integrity)
// launcher atoms. The binary ships alongside the monad executable (installed into bin/ by
// build-release.ts). The daemon may override its path via config.sandbox.launcherPath —
// since a launcher atom is a static object (it can't take the config at construction), the daemon
// pushes the override here once at boot through configureNativeLauncherPath().

import { accessSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';

let overridePath: string | undefined;

/** Set the explicit native-launcher path (config.sandbox.launcherPath). Called once at boot. */
export function configureNativeLauncherPath(path: string | undefined): void {
  overridePath = path;
}

/**
 * Locate a native launcher binary. Priority: explicit override (from config) → binary next to the
 * monad executable (standard install path). Returns null when neither is executable.
 */
export function findNativeLauncherBin(binName: string): string | null {
  const candidates: string[] = [];
  if (overridePath) candidates.push(overridePath);
  candidates.push(join(dirname(process.execPath), binName));
  for (const p of candidates) {
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      /* try next */
    }
  }
  return null;
}
