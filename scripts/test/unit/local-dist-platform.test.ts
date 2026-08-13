import { describe, expect, test } from 'bun:test';
import { posix, win32 } from 'node:path';

import { distInstallerKind, localDistTarget, localInstallPlan } from '../../lib/local-dist-platform.ts';

describe('local dist platform', () => {
  test.each([
    ['darwin', 'arm64', 'gnu', 'aarch64-apple-darwin'],
    ['darwin', 'x64', 'gnu', 'x86_64-apple-darwin'],
    ['linux', 'arm64', 'gnu', 'aarch64-unknown-linux-gnu'],
    ['linux', 'x64', 'musl', 'x86_64-unknown-linux-musl'],
    ['win32', 'arm64', 'gnu', 'aarch64-pc-windows-msvc'],
    ['win32', 'x64', 'gnu', 'x86_64-pc-windows-msvc']
  ] as const)('maps %s/%s/%s to %s', (platform, arch, libc, target) => {
    expect(localDistTarget(platform, arch, libc)).toBe(target);
  });

  test('rejects architectures that have no release artifact', () => {
    expect(() => localDistTarget('linux', 'ia32')).toThrow('unsupported local build architecture: ia32');
  });

  test('selects the installer emitted by a single-target dist build', () => {
    expect([
      distInstallerKind('aarch64-apple-darwin'),
      distInstallerKind('x86_64-unknown-linux-gnu'),
      distInstallerKind('aarch64-pc-windows-msvc')
    ]).toEqual(['shell', 'shell', 'powershell']);
  });

  test('uses the shell installer and extensionless binary on Unix', () => {
    expect(localInstallPlan('darwin', '/artifacts', '/install')).toEqual({
      binary: posix.join('/install', 'monad'),
      installer: posix.join('/artifacts', 'install.sh'),
      command: ['sh', posix.join('/artifacts', 'install.sh')]
    });
  });

  test('uses Windows PowerShell 5.1-compatible invocation and monad.exe', () => {
    expect(localInstallPlan('win32', 'C:\\artifacts', 'C:\\install')).toEqual({
      binary: win32.join('C:\\install', 'monad.exe'),
      installer: win32.join('C:\\artifacts', 'install.ps1'),
      command: [
        'powershell.exe',
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        win32.join('C:\\artifacts', 'install.ps1')
      ]
    });
  });
});
