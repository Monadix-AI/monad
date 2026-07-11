import type { WorkspaceAction } from '@monad/protocol';

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeOpenPathCommands, openNativePath } from '@monad/home';

export interface WorkspaceActionCommand {
  argv: string[];
  env?: Record<string, string>;
}

const DRAFT_ATTACHMENT_DIR = 'monad-draft-attachments';

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
    return nativeOpenPathCommands(cwd, 'reveal', platform);
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

function safeAttachmentName(name: string): string {
  const cleaned = Array.from(name)
    .map((char) => (char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char) ? '_' : char))
    .join('')
    .replace(/^\.+$/, 'file');
  return cleaned.slice(0, 180) || 'file';
}

export async function openDraftAttachment({ data, name }: { data: Uint8Array; name: string }): Promise<void> {
  const dir = join(tmpdir(), DRAFT_ATTACHMENT_DIR);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${randomUUID()}-${safeAttachmentName(name)}`);
  await writeFile(path, data);
  await openNativePath(path);
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
