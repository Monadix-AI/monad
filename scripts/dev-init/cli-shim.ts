import { chmod, mkdir } from 'node:fs/promises';
import { join, win32 } from 'node:path';

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function devCliShimText(root: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const entrypoint = win32.join(root, 'apps', 'cli', 'src', 'bin.ts');
    return `@echo off\r\nbun "${entrypoint}" %*\r\n`;
  }

  const entrypoint = join(root, 'apps', 'cli', 'src', 'bin.ts');
  return `#!/bin/sh\nexec bun ${quoteShell(entrypoint)} "$@"\n`;
}

export async function installDevCliShim(root: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  const binDir = join(root, '.dev', 'bin');
  const shimPath = join(binDir, platform === 'win32' ? 'monad.cmd' : 'monad');

  await mkdir(binDir, { recursive: true });
  await Bun.write(shimPath, devCliShimText(root, platform));
  if (platform !== 'win32') await chmod(shimPath, 0o755);

  return shimPath;
}
