import { posix, win32 } from 'node:path';

import { type DistTarget, distTargetFromReleaseTarget, releaseTargetFromDistTarget } from './release-target.ts';

type LocalPlatform = 'darwin' | 'linux' | 'win32';
type LocalArch = 'arm64' | 'x64';

export interface LocalInstallPlan {
  binary: string;
  installer: string;
  command: string[];
}

export type DistInstallerKind = 'powershell' | 'shell';

export function distInstallerKind(target: string): DistInstallerKind {
  return releaseTargetFromDistTarget(target).os === 'windows' ? 'powershell' : 'shell';
}

export function localDistTarget(
  platform: NodeJS.Platform,
  arch: string,
  linuxLibc: 'gnu' | 'musl' = 'gnu'
): DistTarget {
  const localPlatform = requireLocalPlatform(platform);
  const localArch = requireLocalArch(arch);
  return distTargetFromReleaseTarget({
    os: localPlatform === 'win32' ? 'windows' : localPlatform,
    arch: localArch,
    ...(localPlatform === 'linux' && linuxLibc === 'musl' ? { libc: 'musl' as const } : {})
  });
}

export function localInstallPlan(
  platform: NodeJS.Platform,
  artifactsDir: string,
  installDir: string
): LocalInstallPlan {
  const localPlatform = requireLocalPlatform(platform);
  if (localPlatform === 'win32') {
    const installer = win32.join(artifactsDir, 'install.ps1');
    return {
      binary: win32.join(installDir, 'monad.exe'),
      installer,
      command: ['powershell.exe', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer]
    };
  }

  const installer = posix.join(artifactsDir, 'install.sh');
  return { binary: posix.join(installDir, 'monad'), installer, command: ['sh', installer] };
}

function requireLocalPlatform(platform: NodeJS.Platform): LocalPlatform {
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') return platform;
  throw new Error(`unsupported local build platform: ${platform}`);
}

function requireLocalArch(arch: string): LocalArch {
  if (arch === 'arm64' || arch === 'x64') return arch;
  throw new Error(`unsupported local build architecture: ${arch}`);
}
