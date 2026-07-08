import type { MonadAuth } from '@monad/home';

import { tryResolveSecretMap } from '#/config/secrets.ts';

// Markers a nested CLI must not inherit. The CLI refuses to start when it sees its own
// nested-session guard (which leaks down whenever monad was itself launched from the same
// session), and monad's own session markers should never reach a child agent.
const STRIPPED_CHILD_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'] as const;

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
 * Build the child CLI's environment: the daemon env (minus nested-session markers) overlaid with the
 * agent's own env (minus injection vectors). Agent values win for non-denied keys.
 */
export function mergeExternalAgentChildEnv(agentEnv?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (value !== undefined && !STRIPPED_CHILD_ENV.includes(key as (typeof STRIPPED_CHILD_ENV)[number])) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(agentEnv ?? {})) {
    if (!ENV_INJECT_DENYLIST.has(key.toUpperCase())) env[key] = value;
  }
  return env;
}

/**
 * Resolve `${env:NAME}` / `${secret:NAME}` references in the agent env so API keys live in the daemon
 * environment or auth.json keychain rather than plaintext config.json. Plain values pass through
 * unchanged; unresolvable refs are dropped (best-effort) so a missing key doesn't block the spawn.
 */
export function resolveExternalAgentEnv(
  agentEnv: Record<string, string> | undefined,
  auth: MonadAuth | undefined
): Record<string, string> | undefined {
  return tryResolveSecretMap(agentEnv, auth);
}
