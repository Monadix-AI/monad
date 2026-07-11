import type { HostCommand, NativeOpenMode } from './host-platform-contract.ts';

import { hostPlatformModule } from './host-platform.ts';

export type { HostCommand as NativeOpenCommand, NativeOpenMode } from './host-platform-contract.ts';

export function nativeOpenPathCommands(
  path: string,
  mode: NativeOpenMode = 'open',
  platform: NodeJS.Platform = process.platform
): HostCommand[] {
  return [...hostPlatformModule.forPlatform(platform).openPathCommands(path, mode)];
}

export async function openNativePath(path: string, mode: NativeOpenMode = 'open'): Promise<void> {
  let lastError: unknown;
  for (const command of hostPlatformModule.current.openPathCommands(path, mode)) {
    try {
      const proc = Bun.spawn(command.argv, {
        env: { ...Bun.env, ...(command.env ?? {}) },
        stdout: 'ignore',
        stderr: 'ignore',
        stdin: 'ignore'
      });
      proc.unref();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Open native path failed: ${path}`);
}
