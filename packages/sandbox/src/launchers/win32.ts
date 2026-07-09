// Windows sandbox launcher atom — wraps the child in `monad-sandbox-launcher.exe`, which applies
// Low Integrity token + Job Object isolation before launching the real command. The binary must
// live alongside the monad binary (installed into bin/ by build-release.ts); if absent,
// isAvailable() returns false and the daemon's registry falls back to noneLauncher (runs
// unconfined with a warning).
//
// The Low Integrity token prevents the child from writing to Medium/High integrity objects (user
// profile, monad config, SSH keys, registry). Writable roots are granted Low Integrity
// GENERIC_ALL before the child starts so it can write to its session sandbox root. A Job Object
// ensures the child tree is killed if the launcher exits unexpectedly.

import type { SandboxLauncher } from '@monad/sdk-atom';

import { logger } from '@monad/logger';
import { defineLocalLauncher } from '@monad/sdk-atom';

import { findNativeLauncherBin } from './native-path.ts';

const LAUNCHER_BIN = 'monad-sandbox-launcher.exe';

// A Low Integrity token restricts writes but cannot redirect a read to a fake file nor deny a
// specific file (only AppContainer's DENY ACEs can). So a masked-file policy is NOT enforced here —
// the real file stays readable in cleartext. Warn once; the honest fix is the AppContainer launcher
// (monad-sandbox-appcontainer.exe), auto-selected when present.
let maskedFilesWarned = false;
function warnMaskedFilesUnenforced(count: number): void {
  if (maskedFilesWarned) return;
  maskedFilesWarned = true;
  logger.warn(
    `monad: ${count} masked credential file(s) are NOT enforced under the Low Integrity launcher — ` +
      'it cannot redirect or deny a single file, so the file is readable in cleartext by the ' +
      'sandboxed child. Install the AppContainer launcher to enforce credential file masking.'
  );
}

export const win32Launcher: SandboxLauncher = defineLocalLauncher({
  kind: 'lowintegrity',
  platforms: ['win32'],
  // Low Integrity restricts writes but does NOT block credential reads or network egress
  // (the net policy is advisory on Windows).
  enforces: { writeConfine: true },
  isAvailable: () => findNativeLauncherBin(LAUNCHER_BIN) !== null,
  wrap(argv, policy) {
    const bin = findNativeLauncherBin(LAUNCHER_BIN);
    if (!bin) throw new Error(`${LAUNCHER_BIN} not found — cannot apply Windows (Low Integrity) sandbox`);
    if (policy.maskedFiles?.length) warnMaskedFilesUnenforced(policy.maskedFiles.length);
    const args: string[] = [bin];
    for (const p of policy.writableRoots ?? []) args.push('--writable', p);
    args.push('--', ...argv);
    return args;
  }
});
