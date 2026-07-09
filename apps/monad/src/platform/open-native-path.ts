export type NativeOpenMode = 'open' | 'reveal';

export interface NativeOpenCommand {
  argv: string[];
  env?: Record<string, string>;
}

export function nativeOpenPathCommands(
  path: string,
  mode: NativeOpenMode = 'open',
  platform: NodeJS.Platform = process.platform
): NativeOpenCommand[] {
  switch (platform) {
    case 'darwin':
      return mode === 'reveal' ? [{ argv: ['open', '-R', path] }] : [{ argv: ['open', path] }];
    case 'win32':
      if (mode === 'reveal') return [{ argv: ['explorer.exe', '/select,', path] }];
      return [
        {
          argv: ['powershell.exe', '-NoProfile', '-Command', 'Start-Process -LiteralPath $env:MONAD_OPEN_PATH'],
          env: { MONAD_OPEN_PATH: path }
        }
      ];
    default:
      return [{ argv: ['xdg-open', path] }];
  }
}

export async function openNativePath(path: string, mode: NativeOpenMode = 'open'): Promise<void> {
  let lastError: unknown;
  for (const command of nativeOpenPathCommands(path, mode)) {
    try {
      const proc = Bun.spawn(command.argv, {
        env: { ...Bun.env, ...(command.env ?? {}) },
        stdout: 'ignore',
        stderr: 'ignore',
        stdin: 'ignore'
      });
      proc.unref();
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Open native path failed: ${path}`);
}
