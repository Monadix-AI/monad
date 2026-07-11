import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface StartupIdentity {
  name: 'Monad' | 'Monad Dev';
  slug: 'monad' | 'monad-dev';
  developer: typeof DEVELOPER_NAME;
}

export interface WindowsStartupShortcut {
  path: string;
  name: string;
  iconPath: string;
  command: string[];
  monadHome: string;
  logPath: string;
}

export const DEVELOPER_NAME = 'Monadix Labs, Inc.';

export function startupIdentity(command: string[]): StartupIdentity {
  const isDev = command.some(
    (arg) => arg.endsWith('/apps/monad/src/main.ts') || arg.endsWith('\\apps\\monad\\src\\main.ts')
  );
  return {
    name: isDev ? 'Monad Dev' : 'Monad',
    slug: isDev ? 'monad-dev' : 'monad',
    developer: DEVELOPER_NAME
  };
}

export function startupIconPath(platform: 'darwin' | 'linux' | 'win32', command: string[]): string {
  const filename = platform === 'win32' ? 'favicon.ico' : 'monad-icon-vector-solid.svg';
  const candidates = assetCandidates(command, filename);
  return candidates.find((path) => existsSync(path)) ?? 'monad';
}

function assetCandidates(command: string[], filename: string): string[] {
  const candidates: string[] = [];
  const script = command.find(
    (arg) => arg.endsWith('/apps/monad/src/main.ts') || arg.endsWith('\\apps\\monad\\src\\main.ts')
  );
  if (script) {
    const marker = join('apps', 'monad', 'src', 'main.ts');
    candidates.push(join(script.slice(0, script.length - marker.length), 'apps', 'web', 'public', filename));
  }
  const executable = command[0];
  if (executable) {
    candidates.push(join(dirname(executable), '..', 'assets', filename));
    if (filename === 'favicon.ico' && basename(executable).toLowerCase().includes('monad')) candidates.push(executable);
  }
  candidates.push(join(process.cwd(), 'apps', 'web', 'public', filename), join(process.cwd(), 'assets', filename));
  return candidates;
}

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function quoteDesktop(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function escapeCmdValue(value: string): string {
  return value.replaceAll('"', '""');
}

export function quoteWindowsArg(value: string): string {
  return `"${escapeCmdValue(value)}"`;
}

export function powerShellString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
