// Registry of sandbox launchers. Two tiers, selected by config:
//   • LIGHT — a CLOSED internal set of OS-primitive launchers (Seatbelt / bwrap / Landlock /
//     AppContainer / Low-Integrity). These are NOT atoms and are NOT registered through the atom
//     gate; they always exist. `backend:'auto'` (the default) picks the first LIGHT launcher that is
//     a candidate for the platform.
//   • HEAVY — opt-in atom launchers (docker / e2b / a future vm backend), contributed by an atom pack
//     (e.g. @monad/monad-power-pack) through the atom-pack loader's onSandbox sink. A heavy backend is
//     used ONLY when explicitly selected via config.sandbox.backend, never auto-selected.
//
// At boot the daemon calls selectSandboxLauncher(platform, backend) to pick which launcher confines
// spawned children and wires it into the seam via configureSandboxLauncher — the LLM-facing tools
// never change. No LIGHT candidate → noneLauncher (unconfined) so the daemon still runs, with a
// warning at the call site.

import type { SandboxLauncher } from '@monad/sdk-atom';

import { logger } from '@monad/logger';
import { noneLauncher } from '@monad/sdk-atom';

import { bwrapLauncher } from './launchers/bwrap.ts';
import { landlockLauncher } from './launchers/landlock.ts';
import { seatbeltLauncher } from './launchers/seatbelt.ts';
import { win32Launcher } from './launchers/win32.ts';
import { win32AppContainerLauncher } from './launchers/win32-appcontainer.ts';

type Source = 'builtin' | 'atom';
type Backend = 'auto' | 'docker' | 'e2b' | 'vm';

interface Entry {
  launcher: SandboxLauncher;
  source: Source;
}

// The closed set of light OS launchers, in priority order (first match wins on auto):
//   macOS  → Seatbelt · Linux → bwrap → Landlock · Windows → AppContainer → Low-Integrity.
const LIGHT: SandboxLauncher[] = [
  seatbeltLauncher,
  bwrapLauncher,
  landlockLauncher,
  win32AppContainerLauncher,
  win32Launcher
];

// HEAVY atom launchers only (docker/e2b/vm). Registered via the atom gate; wiped on hot-reload.
const entries: Entry[] = [];

// Backend options the daemon passes to heavy launchers WITHOUT importing them (both depend on
// @monad/sandbox). Module-level state, set at boot before selection.
let backendOptions: { dockerImage?: string } = {};

/** Wire backend options (e.g. the docker image) at daemon boot, before launcher selection. */
export function configureSandboxBackendOptions(opts: { dockerImage?: string }): void {
  backendOptions = { ...opts };
}

/** The configured backend options, for a heavy launcher's spawn(). */
export function sandboxBackendOptions(): { dockerImage?: string } {
  return backendOptions;
}

/** Register a HEAVY atom launcher (docker/e2b/vm). Light launchers are the closed internal set. */
export function registerSandboxLauncher(launcher: SandboxLauncher, source: Source): void {
  entries.push({ launcher, source });
}

/** Drop all registered HEAVY launchers — used by atom-pack hot-reload before re-registering survivors.
 *  Never touches the closed LIGHT set. */
export function clearSandboxLaunchers(): void {
  entries.length = 0;
}

/** Tell every launcher (light + heavy) to release a session's per-session resources when it ends.
 *  Only a launcher that keeps per-session state (e.g. a cloud launcher's reused remote instance)
 *  acts; the rest no-op. */
export function disposeSandboxSession(sessionId: string): void {
  for (const l of LIGHT) void l.disposeSession?.(sessionId);
  for (const e of entries) void e.launcher.disposeSession?.(sessionId);
}

/** Tell every launcher to release an agent's per-agent resources when the agent is deleted or its
 *  sandbox config changes. Only a launcher that keeps per-agent state (the VM backend's one VM per
 *  agent) acts; the rest no-op. Destroying the instance here is a security constraint — a stale
 *  instance must never outlive the policy it was built for. */
export function disposeSandboxAgent(agentId: string): void {
  for (const l of LIGHT) void l.disposeAgent?.(agentId);
  for (const e of entries) void e.launcher.disposeAgent?.(agentId);
}

function isCandidate(launcher: SandboxLauncher, platform: NodeJS.Platform): boolean {
  if (launcher.platforms && !launcher.platforms.includes(platform)) return false;
  return launcher.isAvailable?.() ?? true;
}

function selectAuto(platform: NodeJS.Platform): SandboxLauncher {
  return LIGHT.find((l) => isCandidate(l, platform)) ?? noneLauncher;
}

/**
 * Pick the launcher for the platform and configured backend:
 *   • 'auto' → the first LIGHT launcher that is a candidate (platform + available), else noneLauncher.
 *     No heavy atom launcher is ever auto-selected.
 *   • 'docker' | 'e2b' | 'vm' → a registered heavy launcher whose kind === backend, returned EVEN IF
 *     isAvailable() is currently false (its prepare() runs later, then finalize re-checks). If no heavy
 *     launcher of that kind is registered (pack not enabled), warn and fall back to the auto light default.
 */
export function selectSandboxLauncher(
  platform: NodeJS.Platform = process.platform,
  backend: Backend = 'auto'
): SandboxLauncher {
  if (backend === 'auto') return selectAuto(platform);

  const heavy = entries.filter((e) => e.launcher.kind === backend);
  // Two+ heavy launchers of the same kind is almost certainly unintended (the loser is silently
  // shadowed); surface it so the operator can remove one rather than guess which won.
  if (heavy.length > 1) {
    logger.warn(
      `monad: ${heavy.length} sandbox launchers registered for backend "${backend}" — using the first, shadowing the rest`
    );
  }
  const chosen = heavy[0]?.launcher;
  if (chosen) return chosen;

  logger.warn(
    `monad: agent.sandbox.backend="${backend}" but no "${backend}" sandbox launcher is registered ` +
      '(is the atom pack that provides it enabled?) — falling back to the light OS sandbox.'
  );
  return selectAuto(platform);
}
