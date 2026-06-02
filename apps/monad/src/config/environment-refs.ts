import { matchEnvRef } from '@monad/environment';

/**
 * Resolve an environment reference in an arbitrary environment mapping.
 * - `${env:NAME}` — reads from the daemon environment (throws if unset)
 * - plain value — passes through unchanged
 */
export function resolveEnvironmentRef(value: string): string {
  if (value.startsWith('${secret:')) {
    throw new Error('secret references are unsupported; store native credentials directly');
  }
  const envMatch = matchEnvRef(value);
  if (envMatch) {
    const key = envMatch[1] as string;
    const resolved = Bun.env[key];
    if (resolved === undefined) throw new Error(`environment reference "${value}" is unset (env ${key} not defined)`);
    return resolved;
  }
  return value;
}

export function resolveEnvironmentMap(map: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!map) return undefined;
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, resolveEnvironmentRef(v)]));
}

/**
 * Best-effort environment-map resolution: silently skips entries whose refs can't be satisfied.
 * Used for preset defaults where a missing API key
 * shouldn't block the adapter from trying its own credential discovery (e.g. ~/.claude).
 * Entries with unresolvable refs are dropped from the result.
 */
export function tryResolveEnvironmentMap(map: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!map) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    try {
      out[k] = resolveEnvironmentRef(v);
    } catch (err) {
      // Expected: env var unset or unsupported legacy syntax — skip so preset defaults don't block spawn.
      // Unexpected errors surface to stderr for debugging.
      if (
        !(
          err instanceof Error &&
          (err.message.startsWith('environment reference') || err.message.startsWith('secret references'))
        )
      ) {
        process.stderr.write(`tryResolveEnvironmentMap: unexpected error for key "${k}": ${String(err)}\n`);
      }
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
