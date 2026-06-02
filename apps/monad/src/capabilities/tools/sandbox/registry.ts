// Registry of sandbox launcher atoms. The built-in pack registers the OS launchers (Seatbelt /
// Landlock / Low-Integrity) and a discovered third-party pack may register more (e.g. a future
// cloud e2b/Vercel launcher); both arrive through the atom-pack loader's onSandbox sink. At boot
// the daemon calls select(platform) to pick which launcher actually confines spawned children and
// wires it into the seam via configureSandboxLauncher — the LLM-facing tools never change.
//
// Selection: a launcher is a candidate when it targets the platform (platforms undefined = any) and
// reports available (native binary present / API key set). Third-party launchers win over built-ins
// (a user who installed an e2b launcher meant to use it); within a source, registration order wins.
// No candidate → noneLauncher (unconfined) so the daemon still runs, with a warning at the call site.

import type { SandboxLauncher } from '@monad/sdk-atom';

import { logger } from '@monad/logger';
import { noneLauncher } from '@monad/sdk-atom';

type Source = 'builtin' | 'atom';

interface Entry {
  launcher: SandboxLauncher;
  source: Source;
}

const entries: Entry[] = [];

/** Register a launcher. `source` decides precedence on select (third-party `atom` beats `builtin`). */
export function registerSandboxLauncher(launcher: SandboxLauncher, source: Source): void {
  entries.push({ launcher, source });
}

/** Drop all registered launchers — used by atom-pack hot-reload before re-registering survivors. */
export function clearSandboxLaunchers(): void {
  entries.length = 0;
}

/** Tell every launcher to release a session's per-session resources (called when the session ends).
 *  Only a launcher that keeps per-session state (e.g. a cloud launcher's reused remote instance)
 *  acts; the rest no-op. */
export function disposeSandboxSession(sessionId: string): void {
  for (const e of entries) void e.launcher.disposeSession?.(sessionId);
}

function isCandidate(launcher: SandboxLauncher, platform: NodeJS.Platform): boolean {
  if (launcher.platforms && !launcher.platforms.includes(platform)) return false;
  return launcher.isAvailable?.() ?? true;
}

/**
 * Pick the launcher for the platform: third-party before built-in, then registration order. Returns
 * noneLauncher when nothing matches (caller logs the unconfined fallback).
 */
export function selectSandboxLauncher(platform: NodeJS.Platform = process.platform): SandboxLauncher {
  const candidates = entries.filter((e) => isCandidate(e.launcher, platform));
  const atoms = candidates.filter((e) => e.source === 'atom');
  // Two+ third-party launchers for one platform is almost certainly unintended (the loser is
  // silently shadowed); surface it so the operator can remove one rather than guess which won.
  if (atoms.length > 1) {
    logger.warn(
      `monad: ${atoms.length} third-party sandbox launchers target ${platform} (${atoms.map((e) => e.launcher.kind).join(', ')}) — using "${atoms[0]?.launcher.kind}", shadowing the rest`
    );
  }
  const chosen = atoms[0] ?? candidates.find((e) => e.source === 'builtin');
  return chosen?.launcher ?? noneLauncher;
}
