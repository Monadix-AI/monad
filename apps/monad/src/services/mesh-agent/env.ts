import type { MonadAuth } from '@monad/environment';
import type { MeshAgentEnvironmentPolicy } from '@monad/sdk-atom';

import { tryResolveSecretMap } from '#/config/secrets.ts';

// Ambient nested-session markers monad may itself have inherited from the CLI that launched it. A
// child CLI refuses to start when it sees its own nested-session guard. The leak originates in the
// daemon's own environment rather than in any provider, so this is a daemon-wide invariant, not
// adapter-owned policy: no child of any provider may see them, whatever the source.
const DAEMON_CHILD_ENV_STRIP = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'] as const;

// Env keys that hijack a spawned process regardless of value: loader injection (LD_PRELOAD /
// DYLD_INSERT_LIBRARIES), PATH/loader substitution, and language startup-file vectors. The agent env
// is operator config, but strip these defensively so a stray entry can't change how the CLI loads.
const ENV_INJECT_DENYLIST = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FORCE_FLAT_NAMESPACE',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PYTHONHOME',
  'RUBYLIB',
  'RUBYOPT',
  'PERL5LIB',
  'PERL5OPT',
  'BASH_ENV',
  'ENV',
  'ZDOTDIR'
]);

/**
 * The keys no child of this provider may carry: the daemon's own invariants unioned with the
 * adapter's policy and, when the agent is launched through a specific delivery, that delivery's.
 * Union only — an adapter or delivery can add keys but can never restore one the daemon forbids.
 */
export function meshAgentStripKeys(...policies: Array<MeshAgentEnvironmentPolicy | undefined>): Set<string> {
  const keys = new Set<string>(DAEMON_CHILD_ENV_STRIP);
  for (const policy of policies) for (const key of policy?.strip ?? []) keys.add(key);
  return keys;
}

// Windows resolves environment names case-insensitively, so an exact-case delete would leave a
// differently-cased marker (`Claudecode`) readable by the child through `getenv("CLAUDECODE")`. POSIX
// names are genuinely distinct by case — `PATH` and `path` are two variables — so folding there would
// over-delete. The fold therefore tracks the platform's own semantics instead of being unconditional.
const ENV_NAMES_ARE_CASE_INSENSITIVE = process.platform === 'win32';

/** Enforce a strip set against a built env, matching the host's environment-name case semantics. */
export function stripEnvKeys(env: Record<string, string | undefined>, stripKeys: ReadonlySet<string>): void {
  if (!ENV_NAMES_ARE_CASE_INSENSITIVE) {
    for (const key of stripKeys) delete env[key];
    return;
  }
  const folded = new Set<string>();
  for (const key of stripKeys) folded.add(key.toUpperCase());
  for (const key of Object.keys(env)) if (folded.has(key.toUpperCase())) delete env[key];
}

/**
 * Build the child CLI's environment. Two policies with different shapes, applied at different points:
 * `ENV_INJECT_DENYLIST` is a WRITE permission — operator config may not set a loader key, but one
 * inherited from the daemon still passes through. `stripKeys` is an INVARIANT on the result, so it
 * runs after every overlay; applying it to the inherited env alone would let the agent's own env put
 * a stripped key straight back.
 */
export function mergeMeshAgentChildEnv(
  agentEnv?: Record<string, string>,
  stripKeys: ReadonlySet<string> = meshAgentStripKeys()
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) if (value !== undefined) env[key] = value;
  for (const [key, value] of Object.entries(agentEnv ?? {})) {
    if (!ENV_INJECT_DENYLIST.has(key.toUpperCase())) env[key] = value;
  }
  stripEnvKeys(env, stripKeys);
  return env;
}

/**
 * Resolve `${env:NAME}` / `${secret:NAME}` references in the agent env so API keys live in the daemon
 * environment or auth.json keychain rather than plaintext config.json. Plain values pass through
 * unchanged; unresolvable refs are dropped (best-effort) so a missing key doesn't block the spawn.
 */
export function resolveMeshAgentEnv(
  agentEnv: Record<string, string> | undefined,
  auth: MonadAuth | undefined
): Record<string, string> | undefined {
  return tryResolveSecretMap(agentEnv, auth);
}
