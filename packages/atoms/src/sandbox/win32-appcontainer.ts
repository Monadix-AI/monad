// Windows AppContainer sandbox launcher atom — wraps the child in
// `monad-sandbox-appcontainer.exe`, which applies an AppContainer profile
// before launching the real command. Stronger than the Low Integrity launcher:
//   • AppContainer provides a separate FS namespace and network isolation.
//   • readDeny is enforced via explicit DENY ACEs on the AppContainer SID,
//     closing the credential-read gap that Low IL cannot address.
//   • net:'none' is enforced by omitting all network capabilities from the
//     AppContainer security-capabilities list; the child gets no IP sockets.
//
// Profile lifecycle: each session uses a profile named "monad.<sanitized-id>".
// The profile is created lazily on first spawn and cleaned up via disposeSession
// (daemon calls this when the session ends). Orphaned profiles from crashes are
// swept by the next daemon start via sweepOrphanSandboxProfiles in the atoms pack.
//
// The binary must live alongside the monad binary (installed into bin/ by
// build-release.ts). If absent, isAvailable() returns false and the registry
// falls back to the Low IL launcher (monad-sandbox-launcher.exe) if present,
// then to noneLauncher.

import type { SandboxLauncher, SandboxPolicy } from '@monad/sdk-atom';

import { defineLocalLauncher } from '@monad/sdk-atom';

import { findNativeLauncherBin } from './native-path.ts';

const LAUNCHER_BIN = 'monad-sandbox-appcontainer.exe';

/** Transform a session ID into a valid AppContainer profile name (max 64 chars,
 *  only alphanumeric, '.', '_'). Example: ses_abc-123 → monad.ses_abc123 */
function profileName(sessionId: string): string {
  const sanitized = sessionId.replace(/[^a-zA-Z0-9_.]/g, '');
  return `monad.${sanitized}`.slice(0, 64);
}

async function spawnBestEffort(bin: string, args: string[]): Promise<void> {
  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolve) => {
    const proc = spawn(bin, args, { stdio: 'ignore' });
    proc.on('close', () => resolve());
    proc.on('error', () => resolve());
  });
}

async function cleanupProfile(bin: string, sessionId: string): Promise<void> {
  await spawnBestEffort(bin, ['--cleanup-profile', profileName(sessionId)]);
}

/**
 * Sweep AppContainer profiles whose names start with "monad." — called by the
 * daemon on startup to reclaim profiles orphaned by a prior crash (disposeSession
 * was never called). Best-effort: silently ignored on error or when binary absent.
 */
export async function sweepOrphanAppContainerProfiles(): Promise<void> {
  if (process.platform !== 'win32') return;
  const bin = findNativeLauncherBin(LAUNCHER_BIN);
  if (!bin) return;
  await spawnBestEffort(bin, ['--sweep-profiles', 'monad.']);
}

/** Pure arg builder — exported for unit tests; wrap() prepends the binary path. */
export function buildAppContainerArgs(argv: string[], policy: SandboxPolicy): string[] {
  const args: string[] = [];

  if (policy.sessionId) args.push('--profile', profileName(policy.sessionId));

  for (const p of policy.writableRoots ?? []) args.push('--writable', p);
  for (const p of policy.readDenyRoots ?? []) args.push('--deny-read', p);

  // Grant network capabilities for filtered/unrestricted modes.
  if (policy.net !== 'none') args.push('--net-client');

  args.push('--', ...argv);
  return args;
}

export const win32AppContainerLauncher: SandboxLauncher = defineLocalLauncher({
  kind: 'appcontainer',
  platforms: ['win32'],
  enforces: { writeConfine: true, readDeny: true, net: ['none'] },
  isAvailable: () => findNativeLauncherBin(LAUNCHER_BIN) !== null,

  wrap(argv: string[], policy: SandboxPolicy): string[] {
    const bin = findNativeLauncherBin(LAUNCHER_BIN);
    if (!bin) throw new Error(`${LAUNCHER_BIN} not found — cannot apply Windows AppContainer sandbox`);
    return [bin, ...buildAppContainerArgs(argv, policy)];
  },

  async disposeSession(sessionId: string): Promise<void> {
    const bin = findNativeLauncherBin(LAUNCHER_BIN);
    if (bin) await cleanupProfile(bin, sessionId);
  }
});
