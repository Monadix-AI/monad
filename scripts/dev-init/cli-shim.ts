import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// The shim resolves its own worktree from its location instead of baking in an absolute path, so a
// shim copied or inherited from another checkout still runs the source next to it. An absolute path
// here is what used to make a stale .dev/bin silently run a different worktree.
export function devCliShimText(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return '@echo off\r\nbun "%~dp0..\\..\\apps\\cli\\src\\bin.ts" %*\r\n';
  }

  return '#!/bin/sh\nroot=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)\nexec bun "$root/apps/cli/src/bin.ts" "$@"\n';
}

export async function installDevCliShim(root: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  const binDir = join(root, '.dev', 'bin');
  const shimPath = join(binDir, platform === 'win32' ? 'monad.cmd' : 'monad');

  await mkdir(binDir, { recursive: true });
  await Bun.write(shimPath, devCliShimText(platform));
  if (platform !== 'win32') await chmod(shimPath, 0o755);

  return shimPath;
}
