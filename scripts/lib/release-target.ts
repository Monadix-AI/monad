export type ReleaseTarget = {
  os: 'darwin' | 'linux' | 'windows';
  arch: 'arm64' | 'x64';
  libc?: 'musl';
};

const DIST_TARGETS = {
  'aarch64-apple-darwin': { os: 'darwin', arch: 'arm64' },
  'x86_64-apple-darwin': { os: 'darwin', arch: 'x64' },
  'aarch64-unknown-linux-gnu': { os: 'linux', arch: 'arm64' },
  'x86_64-unknown-linux-gnu': { os: 'linux', arch: 'x64' },
  'aarch64-unknown-linux-musl': { os: 'linux', arch: 'arm64', libc: 'musl' },
  'x86_64-unknown-linux-musl': { os: 'linux', arch: 'x64', libc: 'musl' },
  'x86_64-pc-windows-msvc': { os: 'windows', arch: 'x64' }
} as const satisfies Record<string, ReleaseTarget>;

export type DistTarget = keyof typeof DIST_TARGETS;

export function releaseTargetFromDistTarget(target: string): ReleaseTarget {
  const resolved = DIST_TARGETS[target as DistTarget];
  if (!resolved) {
    throw new Error(`Unsupported dist target: ${target}. Supported targets: ${Object.keys(DIST_TARGETS).join(', ')}`);
  }
  return resolved;
}

export function releaseTargetSuffix(target: ReleaseTarget): string {
  return `${target.os}-${target.arch}${target.libc ? `-${target.libc}` : ''}`;
}
