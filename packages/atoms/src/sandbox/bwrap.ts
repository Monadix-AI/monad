// Linux sandbox launcher atom using bubblewrap (bwrap). Alternative to the Landlock launcher for
// hosts that have `bwrap` on PATH; not auto-selected by default (the built-in pack registers
// Landlock for Linux) but kept here for opt-in selection and tests.
//
// Isolation model: user/IPC/UTS/PID namespaces are always unshared; network namespace is
// unshared when net:'none'. Filesystem is built from scratch in the new mount namespace:
// system dirs are ro-bound, caller-supplied writable roots are rw-bound. --die-with-parent
// ensures the confined child is killed when the daemon exits. --unshare-pid prevents the child
// from reading host /proc/<pid>/environ (credential leak).
//
// Merged-usr compatibility: on modern distros /bin, /sbin, /lib* are symlinks into /usr;
// on older distros they are real directories. We inspect each path at runtime and either
// ro-bind (real dir) or recreate the symlink (symlink on host) so both layouts work.

import type { SandboxLauncher, SandboxPolicy } from '@monad/sdk-atom';

import { lstatSync } from 'node:fs';
import { defineLocalLauncher } from '@monad/sdk-atom';

const LEGACY_PATHS: Array<[string, string]> = [
  ['/bin', 'usr/bin'],
  ['/sbin', 'usr/sbin'],
  ['/lib', 'usr/lib'],
  ['/lib32', 'usr/lib32'],
  ['/lib64', 'usr/lib64'],
  ['/libx32', 'usr/libx32']
];

type PathKind = 'dir' | 'symlink' | 'absent';

function probeKind(p: string): PathKind {
  try {
    const st = lstatSync(p);
    if (st.isDirectory()) return 'dir';
    if (st.isSymbolicLink()) return 'symlink';
    return 'absent';
  } catch {
    return 'absent';
  }
}

// Cached per-process: filesystem layout doesn't change mid-run.
let _fixedDirs: { usr: boolean; etc: boolean; opt: boolean } | undefined;
let _legacyKinds: PathKind[] | undefined;

function fixedDirs() {
  if (!_fixedDirs) {
    _fixedDirs = {
      usr: probeKind('/usr') === 'dir',
      etc: probeKind('/etc') === 'dir',
      opt: probeKind('/opt') === 'dir'
    };
  }
  return _fixedDirs;
}

function legacyKinds(): PathKind[] {
  if (!_legacyKinds) _legacyKinds = LEGACY_PATHS.map(([p]) => probeKind(p));
  return _legacyKinds;
}

export function buildBwrapArgs(policy: SandboxPolicy): string[] {
  const args: string[] = [
    '--unshare-user',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-pid',
    '--new-session',
    '--die-with-parent'
  ];

  if (policy.net === 'none' || (typeof policy.net === 'object' && 'allowProxyPort' in policy.net)) {
    args.push('--unshare-net');
  }

  if (policy.writableRoots === undefined) {
    // Unrestricted writes: bind the entire host filesystem rw, then overlay specials below.
    args.push('--bind', '/', '/');
  } else {
    // Confined: read-only system tree, explicit rw roots only.
    const dirs = fixedDirs();
    if (dirs.usr) args.push('--ro-bind', '/usr', '/usr');
    if (dirs.etc) args.push('--ro-bind', '/etc', '/etc');
    if (dirs.opt) args.push('--ro-bind', '/opt', '/opt');

    const kinds = legacyKinds();
    LEGACY_PATHS.forEach(([path, target], i) => {
      if (kinds[i] === 'dir') {
        args.push('--ro-bind', path, path);
      } else if (kinds[i] === 'symlink') {
        args.push('--symlink', target, path);
      }
    });

    for (const root of policy.readableRoots ?? []) {
      args.push('--ro-bind', root, root);
    }

    for (const root of policy.writableRoots) {
      args.push('--bind', root, root);
    }
  }

  // Overlay special filesystems last so they take precedence over any bind above.
  args.push('--dev', '/dev', '--proc', '/proc', '--tmpfs', '/run');

  return args;
}

let _bwrap: string | undefined;
function bwrapBin(): string {
  if (_bwrap === undefined) {
    const found = Bun.which('bwrap');
    if (!found) throw new Error('bwrap not found on PATH — cannot apply Linux sandbox');
    _bwrap = found;
  }
  return _bwrap;
}

export const bwrapLauncher: SandboxLauncher = defineLocalLauncher({
  kind: 'bwrap',
  platforms: ['linux'],
  enforces: { writeConfine: true, net: ['none'] },
  isAvailable: () => Bun.which('bwrap') !== null,
  wrap(argv, policy) {
    return [bwrapBin(), ...buildBwrapArgs(policy), '--', ...argv];
  }
});
