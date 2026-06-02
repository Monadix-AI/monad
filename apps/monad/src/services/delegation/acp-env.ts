import type { AcpAgentConfig } from '@monad/environment';

import { meshAgentStripKeys, prependNodeToolchainPath, stripEnvKeys } from '#/services/mesh-agent/env.ts';
import { findMeshAgentProviderAdapter } from '#/services/mesh-agent/index.ts';

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
  prependNodeToolchainPath(env);
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
