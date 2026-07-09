// Linux sandbox launcher atom — wraps the child in the `monad-sandbox-launcher` native binary,
// which applies a Landlock FS write-restriction ruleset before exec-ing the real command. The
// binary must be present alongside the monad binary (installed into bin/ by build-release.ts); if
// absent, isAvailable() returns false and the daemon's registry falls back to noneLauncher (runs
// unconfined with a warning).
//
// The native binary handles the Landlock syscalls (kernel ≥ 5.13) itself. If the running kernel
// predates Landlock, the binary falls through to exec unconfined rather than failing, so old
// kernels are still usable at the cost of no FS isolation.

import type { SandboxLauncher } from '@monad/sdk-atom';

import { logger } from '@monad/logger';
import { defineLocalLauncher } from '@monad/sdk-atom';

import { findNativeLauncherBin } from './native-path.ts';

const LAUNCHER_BIN = 'monad-sandbox-launcher';

// Landlock is an additive read-ALLOWLIST: it cannot redirect a read to a fake file (only bwrap's
// mount namespace can) nor express "deny this one file, allow the rest". So a masked-file policy is
// NOT enforced here — the real file stays readable in cleartext. Warn once rather than pretend it
// is masked; the honest fix on this host is to install bwrap (auto-selected when present).
let maskedFilesWarned = false;
function warnMaskedFilesUnenforced(count: number): void {
  if (maskedFilesWarned) return;
  maskedFilesWarned = true;
  logger.warn(
    `monad: ${count} masked credential file(s) are NOT enforced under the Landlock launcher — ` +
      'Landlock cannot redirect or deny a single file, so the file is readable in cleartext by the ' +
      'sandboxed child. Install bwrap (auto-selected when on PATH) to enforce credential file masking.'
  );
}

export const landlockLauncher: SandboxLauncher = defineLocalLauncher({
  kind: 'landlock',
  platforms: ['linux'],
  // Landlock restricts writes; net:'none' is enforced in-kernel by the launcher's seccomp filter.
  // It is an additive read-allowlist and CANNOT express "deny ~/.ssh, allow the rest", so no
  // readDeny (tracked in security-guidelines §8); 'filtered' relies on the app-layer egress proxy.
  enforces: { writeConfine: true, net: ['none'] },
  isAvailable: () => findNativeLauncherBin(LAUNCHER_BIN) !== null,
  wrap(argv, policy) {
    const bin = findNativeLauncherBin(LAUNCHER_BIN);
    if (!bin) throw new Error(`${LAUNCHER_BIN} not found — cannot apply Linux (Landlock) sandbox`);
    if (policy.maskedFiles?.length) warnMaskedFilesUnenforced(policy.maskedFiles.length);
    const args: string[] = [bin];
    for (const p of policy.writableRoots ?? []) args.push('--writable', p);
    // net:'none' is enforced in-kernel — the launcher's seccomp filter denies AF_INET/AF_INET6
    // socket creation, so a raw socket can't bypass the HTTP(S)_PROXY env. net:'filtered' (object)
    // and 'unrestricted' are NOT passed: filtered relies on the application-layer egress proxy
    // (seccomp can't allow-by-IP), and 'none' is the only mode seccomp can fully enforce.
    // readDenyRoots is intentionally not forwarded — Landlock can't express it (see above).
    if (policy.net === 'none') args.push('--net', 'none');
    // '--' separates our flags from the real command so the child's argv[0]
    // is never misinterpreted as one of our flags.
    args.push('--', ...argv);
    return args;
  }
});
