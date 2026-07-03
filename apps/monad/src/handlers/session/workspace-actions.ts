import type { WorkspaceAction } from '@monad/protocol';

export interface WorkspaceActionCommand {
  argv: string[];
  env?: Record<string, string>;
}

export function workspaceActionLabel(action: WorkspaceAction, platform: NodeJS.Platform = process.platform): string {
  if (action === 'open-terminal') return 'Open in terminal';
  if (platform === 'darwin') return 'Show in Finder';
  if (platform === 'win32') return 'Show in Explorer';
  return 'Show in file manager';
}

export function workspaceActionCommands(
  action: WorkspaceAction,
  cwd: string,
  platform: NodeJS.Platform = process.platform
): WorkspaceActionCommand[] {
  if (action === 'show-in-file-manager') {
    if (platform === 'darwin') return [{ argv: ['open', '-R', cwd] }];
    if (platform === 'win32') return [{ argv: ['explorer.exe', cwd] }];
    return [{ argv: ['xdg-open', cwd] }];
  }

  if (platform === 'darwin') return [{ argv: ['open', '-a', 'Terminal', cwd] }];
  if (platform === 'win32') {
    return [
      { argv: ['wt.exe', '-d', cwd] },
      {
        argv: ['powershell.exe', '-NoExit', '-Command', 'Set-Location -LiteralPath $env:MONAD_WORKDIR'],
        env: { MONAD_WORKDIR: cwd }
      }
    ];
  }
  return [
    { argv: ['x-terminal-emulator', '--working-directory', cwd] },
    { argv: ['gnome-terminal', '--working-directory', cwd] },
    { argv: ['konsole', '--workdir', cwd] },
    { argv: ['xterm', '-e', 'sh', '-lc', 'cd "$1" && exec sh', 'sh', cwd] }
  ];
}

export async function runWorkspaceAction(action: WorkspaceAction, cwd: string): Promise<void> {
  let lastError: unknown;
  for (const command of workspaceActionCommands(action, cwd)) {
    try {
      const proc = Bun.spawn(command.argv, {
        cwd,
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
  throw lastError instanceof Error ? lastError : new Error(`${workspaceActionLabel(action)} failed`);
}
