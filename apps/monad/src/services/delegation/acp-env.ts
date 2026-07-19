import type { AcpAgentConfig } from '@monad/environment';

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { meshAgentStripKeys, stripEnvKeys } from '#/services/mesh-agent/env.ts';
import { findMeshAgentProviderAdapter } from '#/services/mesh-agent/index.ts';

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
 *  1. Make `osSandbox` usable: when the adapter PROCESS is OS-jailed, sandboxedSpawn redirects HOME to
 *     the disposable sandbox root. Keep adapter-declared credential directories visible and writable;
 *     `??=` preserves an explicit operator-set path. No-op when osSandbox is off.
 *  2. Apply the strip invariant LAST, so no earlier step can reintroduce a forbidden key.
 */
export function adapterSpawnEnv(
  spec: AcpAgentConfig,
  base: Record<string, string | undefined>
): { env: Record<string, string | undefined>; credentialDirs: string[] } {
  const env = { ...base };
  const adapter = findMeshAgentProviderAdapter(spec.name);
  const delivery = adapter?.acp;
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
    for (const credential of delivery?.credentialDirectories ?? []) {
      if (credential.env) env[credential.env] ??= credential.path;
      credentialDirs.push(credential.path);
    }
  }
  stripEnvKeys(env, meshAgentStripKeys(adapter?.environment, delivery?.environment));
  return { env, credentialDirs };
}
