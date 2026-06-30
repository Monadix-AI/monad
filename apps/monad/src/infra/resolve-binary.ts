import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, extname, join } from 'node:path';

// Locate an executable: prefer one on PATH, else the first existing candidate absolute path (e.g. an
// app-bundle location that isn't symlinked onto PATH). Shared by same-machine detection across the
// daemon (acp-agent presets, obscura) so the PATH-then-candidates rule — and any future Windows
// .exe/.cmd handling — lives in one place. Probes are injectable for deterministic tests.

export interface BinProbes {
  which: (name: string) => string | undefined;
  exists: (path: string) => boolean;
}

export const defaultBinProbes: BinProbes = {
  which: (name) => Bun.which(name) ?? searchPath(name),
  exists: existsSync
};

/** PATH lookup, then the first existing candidate path; undefined if none resolve. */
export function resolveBinary(
  name: string,
  candidates: string[],
  probes: BinProbes = defaultBinProbes
): string | undefined {
  return probes.which(name) ?? candidates.find((p) => probes.exists(p));
}

function searchPath(name: string): string | undefined {
  if (name.includes('/') || name.includes('\\')) return isExecutable(name) ? name : undefined;
  for (const dir of searchDirs()) {
    for (const candidate of commandCandidates(name)) {
      const fullPath = join(dir, candidate);
      if (isExecutable(fullPath)) return fullPath;
    }
  }
  return undefined;
}

function searchDirs(): string[] {
  return [
    ...(process.env.PATH ?? '').split(delimiter),
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.bun', 'bin'),
    join(homedir(), 'Library', 'pnpm'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ].filter((dir, index, dirs) => dir.length > 0 && dirs.indexOf(dir) === index);
}

function commandCandidates(name: string): string[] {
  if (process.platform !== 'win32' || extname(name)) return [name];
  const extensions = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  return [name, ...extensions.map((ext) => `${name}${ext.toLowerCase()}`), ...extensions.map((ext) => `${name}${ext}`)];
}

function isExecutable(path: string): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
