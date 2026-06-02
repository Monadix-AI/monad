// macOS sandbox launcher atom — wraps the child in `sandbox-exec` (Seatbelt) with a dynamically
// generated SBPL profile. Ships with every macOS install, so zero bundling / zero host deps.
//
// Confinement model: allow-by-default, then deny ALL filesystem writes and re-allow only the
// policy's writable roots (+ the device nodes interpreters need), deny network when the policy
// says so, and deny reads of the named secret roots. This is the proven pragmatic profile (a
// strict deny-default profile can't reliably let python/bun/bash start). It contains what the
// threat model cares about: host pollution (writes), exfiltration (network), and — via the
// targeted read-deny — credential theft, so a sandboxed snippet cannot read SSH/cloud keys or
// the monad credential store even when egress is open.

import type { SandboxLauncher, SandboxPolicy } from '@monad/sdk-atom';

import { realpathSync } from 'node:fs';
import { defineLocalLauncher } from '@monad/sdk-atom';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** SBPL string literal with the two characters that can break it escaped. */
function sbpl(path: string): string {
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// macOS aliases /tmp→/private/tmp and /var→/private/var; Seatbelt matches the canonical path,
// so a root left as /tmp/... would never match the child's real writes. Resolve up front.
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// Device nodes a shell/interpreter writes to. Without these the child can't even print once we
// flip to deny file-write*.
const DEVICE_WRITES = [
  '(literal "/dev/null")',
  '(literal "/dev/zero")',
  '(literal "/dev/stdout")',
  '(literal "/dev/stderr")',
  '(literal "/dev/tty")',
  '(subpath "/dev/fd")'
];

/** Build the SBPL profile string passed to `sandbox-exec -p`. */
export function buildSeatbeltProfile(policy: SandboxPolicy): string {
  const lines: string[] = ['(version 1)', '(allow default)'];

  // Network: last matching rule wins, so a deny after allow-default takes effect.
  if (policy.net === 'none') {
    lines.push('(deny network*)');
  } else if (policy.net && typeof policy.net === 'object') {
    // Only the local filtering proxy is reachable.
    lines.push('(deny network*)');
    lines.push(`(allow network-outbound (remote ip ${sbpl(`localhost:${policy.net.allowProxyPort}`)}))`);
  }

  // Writes: only confine when the policy names roots. `writableRoots === undefined` means the
  // caller wants no write confinement (e.g. an unrestricted-mode session) — leaving allow-default
  // in place. An empty array is a real, strict policy: deny everything but the device nodes.
  if (policy.writableRoots !== undefined) {
    lines.push('(deny file-write*)');
    const writable = policy.writableRoots.map(canonical).map((p) => `(subpath ${sbpl(p)})`);
    lines.push(`(allow file-write* ${[...writable, ...DEVICE_WRITES].join(' ')})`);
  }

  // Read-deny comes last so it overrides allow-default. Canonicalize so a denied ~/.ssh still
  // matches the child's real read of the /Users/... realpath.
  if (policy.readDenyRoots?.length) {
    const denied = policy.readDenyRoots.map(canonical).map((p) => `(subpath ${sbpl(p)})`);
    lines.push(`(deny file-read* ${denied.join(' ')})`);
  }

  return lines.join('\n');
}

export const seatbeltLauncher: SandboxLauncher = defineLocalLauncher({
  kind: 'seatbelt',
  platforms: ['darwin'],
  // Seatbelt enforces all three: write confinement, credential read-deny, and every net mode.
  enforces: { writeConfine: true, readDeny: true, net: ['none', 'filtered', 'unrestricted'] },
  // sandbox-exec ships with every macOS install.
  isAvailable: () => true,
  wrap(argv, policy) {
    return [SANDBOX_EXEC, '-p', buildSeatbeltProfile(policy), ...argv];
  }
});
