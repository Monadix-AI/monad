import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { findMainWorktreePath } from './worktree';

export type TurboRemoteCacheSync = 'copied' | 'existing' | 'invalid' | 'unavailable';

export interface TurboRemoteCacheDeps {
  fileExists(path: string): Promise<boolean>;
  findMainWorktree(root: string): Promise<string | null>;
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
}

const defaultDeps: TurboRemoteCacheDeps = {
  fileExists: async (path) => Bun.file(path).exists(),
  findMainWorktree: findMainWorktreePath,
  readText: async (path) => Bun.file(path).text(),
  writeText: async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, text);
  }
};

function bindingText(configText: string): string | null {
  try {
    const config = JSON.parse(configText) as { teamId?: unknown };
    if (typeof config.teamId !== 'string' || !config.teamId.trim()) return null;
    return `${JSON.stringify({ teamId: config.teamId }, null, 2)}\n`;
  } catch {
    return null;
  }
}

export async function syncTurboRemoteCache(
  root: string,
  log: (message: string) => void,
  warn: (message: string) => void,
  deps: TurboRemoteCacheDeps = defaultDeps
): Promise<TurboRemoteCacheSync> {
  const targetPath = join(root, '.turbo', 'config.json');
  if (await deps.fileExists(targetPath)) return 'existing';

  const mainWorktree = await deps.findMainWorktree(root);
  if (!mainWorktree) return 'unavailable';

  const sourcePath = join(mainWorktree, '.turbo', 'config.json');
  if (!(await deps.fileExists(sourcePath))) return 'unavailable';

  const text = bindingText(await deps.readText(sourcePath));
  if (!text) {
    warn('main worktree Turbo config has no valid teamId — run `bunx turbo link`');
    return 'invalid';
  }

  await deps.writeText(targetPath, text);
  log('Turbo remote cache linked from main worktree');
  return 'copied';
}
