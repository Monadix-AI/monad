/// <reference types="bun" />
import { join } from 'node:path';

/**
 * Find the main worktree's config.init.json by checking git worktrees.
 * Returns the path to the main worktree's seed file, or null if not found.
 */
async function findMainSeedPath(root: string): Promise<string | null> {
  try {
    const worktreesOutput = await Bun.$`git worktree list --porcelain`
      .quiet()
      .text()
      .then((t) => t.trim())
      .catch(() => '');

    if (!worktreesOutput) return null;

    // porcelain format: blank-line-separated stanzas; each stanza has:
    //   worktree <path>
    //   HEAD <sha>
    //   branch refs/heads/<name>   (or "detached")
    let currentPath = '';
    for (const line of worktreesOutput.split('\n')) {
      if (line.startsWith('worktree ')) {
        currentPath = line.slice('worktree '.length).trim();
      } else if (line.startsWith('branch ')) {
        const branch = line.slice('branch '.length).trim();
        if (branch === 'refs/heads/main' && currentPath && currentPath !== root) {
          const mainSeed = join(currentPath, 'packages', 'home', 'config.init.json');
          if (await Bun.file(mainSeed).exists()) {
            return mainSeed;
          }
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Scaffold packages/home/config.init.json (dev seed) if missing — copying the main worktree's
 * seed when available, otherwise from config.init.json.template — and return the seed's apiKey
 * (empty when unset or the seed is missing/malformed), warning the caller if it's empty.
 */
async function scaffoldConfigInitDevSeed(
  root: string,
  log: (msg: string) => void,
  warn: (msg: string) => void
): Promise<string> {
  const seedPath = join(root, 'packages', 'home', 'config.init.json');
  const seedTemplatePath = join(root, 'packages', 'home', 'config.init.json.template');

  if (!(await Bun.file(seedPath).exists())) {
    // Try to copy from main worktree first
    const mainSeed = await findMainSeedPath(root);
    if (mainSeed) {
      try {
        await Bun.write(seedPath, await Bun.file(mainSeed).text());
        log('config.init.json copied from main worktree');
      } catch {
        // Fall through to template
      }
    }

    // Fall back to template if not copied from main
    if (!(await Bun.file(seedPath).exists())) {
      if (await Bun.file(seedTemplatePath).exists()) {
        await Bun.write(seedPath, await Bun.file(seedTemplatePath).text());
        log('config.init.json created from template');
      } else {
        warn('config.init.json.template not found — skipping dev seed scaffold');
      }
    }
  }

  let seedApiKey = '';
  try {
    const seed = (await Bun.file(seedPath).json()) as { apiKey?: string };
    seedApiKey = (seed.apiKey ?? '').trim();
  } catch {
    /* missing or malformed — covered by the warning below */
  }

  const apiKey = seedApiKey;
  if (!apiKey) {
    warn('No API key in config.init.json (apiKey field)');
    warn('  Get a key at https://openrouter.ai/keys and set it in config.init.json');
    warn('  The daemon will start but AI calls will fail until the key is set.');
  }

  return apiKey;
}

export async function ensureProjectLiveStreamDevSeed(root: string, log: (msg: string) => void): Promise<string> {
  const seedPath = join(root, 'packages', 'protocol', 'test', 'fixtures', 'workplace-project-live-stream.json');
  await Bun.file(seedPath).json();
  log('project live stream dev seed fixture ready');
  return seedPath;
}

export async function scaffoldDevSeed(
  root: string,
  log: (msg: string) => void,
  warn: (msg: string) => void
): Promise<string> {
  await ensureProjectLiveStreamDevSeed(root, log);
  return scaffoldConfigInitDevSeed(root, log, warn);
}
