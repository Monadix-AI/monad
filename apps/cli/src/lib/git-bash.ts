// Windows shell preflight: Git Bash is bundled with the monad Windows installer.
// cmd.exe and PowerShell are not supported.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { t } from './i18n.ts';
import { bold, green, out, red } from './output.ts';

/**
 * Git Bash detection for the Windows `monad init` preflight. Mirrors the daemon's shell
 * backend (apps/monad/src/tools/backends.ts) — kept self-contained here so the CLI does not
 * reach into the daemon's first-party tool internals. Returns null on non-Windows.
 * Priority: explicit path → bundled (shipped in the installer) → system Git.
 */
export function findGitBash(explicitPath?: string): string | null {
  if (process.platform !== 'win32') return null;
  const candidates = [
    explicitPath,
    Bun.env.CLAUDE_CODE_GIT_BASH_PATH,
    join(dirname(process.execPath), '..', 'git', 'bin', 'bash.exe'),
    Bun.env.ProgramFiles && `${Bun.env.ProgramFiles}\\Git\\bin\\bash.exe`,
    Bun.env['ProgramFiles(x86)'] && `${Bun.env['ProgramFiles(x86)']}\\Git\\bin\\bash.exe`,
    Bun.env.LOCALAPPDATA && `${Bun.env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe`
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Windows-only shell preflight for `monad init`. Verifies Git Bash is present (bundled
 * with the installer). No-op on non-Windows.
 */
export function ensureWindowsShell(): void {
  if (process.platform !== 'win32') return;

  out(`\n${bold(t('cli.win.env'))} — ${t('cli.win.shellLabel')}`);

  const bash = findGitBash();
  if (bash) {
    out(green(t('cli.win.gitBashFound', { path: bash })));
    return;
  }

  out(red(t('cli.win.gitBashMissing')));
}
