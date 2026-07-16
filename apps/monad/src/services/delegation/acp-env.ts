import type { AcpAgentConfig } from '@monad/environment';

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Env markers a delegated sub-agent must NOT inherit. Claude Code refuses to start if it sees its own
// CLAUDECODE nested-session guard — which leaks down whenever monad was itself launched from a Claude
// Code session — so the adapter would abort with "cannot be launched inside another Claude Code
// session". Stripped for every adapter (harmless for those that ignore them). Centralized here so the
// set is visible/greppable rather than buried at the spawn site.
const STRIPPED_CHILD_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'] as const;

// Non-interactive spawns (Bun.spawn) don't source the login shell, so version-manager
// shims (nvm/fnm/volta) that only put node/npx on an INTERACTIVE PATH are absent — an
// adapter launched as `npx -y …` then dies with ENOENT ("npx not on PATH"). Prepend
// the real node bin dirs we can find so adapters resolve regardless of how the daemon
// was started. Best-effort + existence-filtered; a no-op when node is already on PATH.
function nodeBinDirs(): string[] {
  const home = homedir();
  const dirs: string[] = [];
  const nvmRoot = join(home, '.nvm', 'versions', 'node');
  try {
    // newest version first (e.g. v26 before v24); numeric sort so v10 > v9.
    for (const v of readdirSync(nvmRoot).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })))
      dirs.push(join(nvmRoot, v, 'bin'));
  } catch {
    // no nvm install — fine
  }
  dirs.push(
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.local', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, 'Library', 'pnpm')
  );
  return dirs.filter((d) => existsSync(d));
}

/**
 * Build the adapter's spawn env + the extra writable roots it needs. Two concerns, both exported for
 * testing:
 *  1. Strip STRIPPED_CHILD_ENV so a nested Claude Code adapter starts as a clean top-level session.
 *  2. Make `osSandbox` usable: when the adapter PROCESS is OS-jailed, sandboxedSpawn redirects HOME to
 *     the disposable sandbox root, hiding the user's real login state (~/.codex, ~/.claude) and breaking
 *     auth. Pin the adapters' config dirs back to the REAL home (these keys survive the HOME overlay
 *     since they aren't in it) AND return those dirs as writable roots so the adapter can also write its
 *     session/history there. `??=` so an explicit operator-set value wins. No-op when osSandbox is off
 *     (HOME isn't redirected, so the adapter finds its real credentials anyway).
 */
export function adapterSpawnEnv(
  spec: AcpAgentConfig,
  base: Record<string, string | undefined>
): { env: Record<string, string | undefined>; credentialDirs: string[] } {
  const env = { ...base };
  for (const key of STRIPPED_CHILD_ENV) delete env[key];
  // Make `npx`/`node` resolvable for adapters even when the daemon was launched without
  // the version-manager's interactive PATH (the common cause of "npx not on PATH").
  const extraPath = nodeBinDirs();
  if (extraPath.length) {
    const seen = new Set<string>();
    env.PATH = [...extraPath, ...(env.PATH ?? '').split(':')]
      .filter((d) => {
        if (!d || seen.has(d)) return false;
        seen.add(d);
        return true;
      })
      .join(':');
  }
  const credentialDirs: string[] = [];
  if (spec.osSandbox === true) {
    const codexHome = join(homedir(), '.codex');
    const claudeDir = join(homedir(), '.claude');
    env.CODEX_HOME ??= codexHome;
    env.CLAUDE_CONFIG_DIR ??= claudeDir;
    credentialDirs.push(codexHome, claudeDir);
  }
  return { env, credentialDirs };
}
