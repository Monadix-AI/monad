import { type MonadAuth, matchEnvRef, matchSecretRef } from '@monad/environment';

/**
 * Resolve a secret reference in a config string.
 * - `${env:NAME}` — reads from the daemon environment (throws if unset)
 * - `${secret:NAME}` — reads from auth.json's namedSecrets (throws if absent)
 * - plain value — passes through unchanged
 */
export function resolveSecretRef(value: string, auth?: MonadAuth): string {
  const envMatch = matchEnvRef(value);
  if (envMatch) {
    const key = envMatch[1] as string;
    const resolved = Bun.env[key];
    if (resolved === undefined) throw new Error(`secret reference "${value}" is unset (env ${key} not defined)`);
    return resolved;
  }
  const secretMatch = matchSecretRef(value);
  if (secretMatch) {
    const name = secretMatch[1] as string;
    const resolved = auth?.namedSecrets?.[name];
    if (resolved === undefined)
      throw new Error(`secret reference "${value}" is unset (run: monad secret set ${name} <value>)`);
    return resolved;
  }
  return value;
}

export function resolveSecretMap(
  map: Record<string, string> | undefined,
  auth?: MonadAuth
): Record<string, string> | undefined {
  if (!map) return undefined;
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, resolveSecretRef(v, auth)]));
}

/**
 * Best-effort secret-map resolution: silently skips entries whose refs can't be satisfied
 * (env var unset / named secret absent). Used for preset defaults where a missing API key
 * shouldn't block the adapter from trying its own credential discovery (e.g. ~/.claude).
 * Entries with unresolvable refs are dropped from the result.
 */
export function tryResolveSecretMap(
  map: Record<string, string> | undefined,
  auth?: MonadAuth
): Record<string, string> | undefined {
  if (!map) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    try {
      out[k] = resolveSecretRef(v, auth);
    } catch (err) {
      // Expected: env var or named secret not set — skip so preset defaults don't block spawn.
      // Unexpected errors (TypeError, bug in resolveSecretRef) surface to stderr for debugging.
      if (!(err instanceof Error && err.message.startsWith('secret reference'))) {
        process.stderr.write(`tryResolveSecretMap: unexpected error for key "${k}": ${String(err)}\n`);
      }
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Resolve a channel token reference. Superset of resolveSecretRef that also activates the
 * `${secret:channel/<id>/token}` scheme, reading from auth.json's channelCredentials so the
 * raw token never lives in config.json. `${env:NAME}` still works; a plain value passes
 * through (discouraged — keep tokens out of config.json).
 */
export function resolveChannelSecretRef(ref: string, auth: MonadAuth): string {
  const envRef = matchEnvRef(ref);
  if (envRef) {
    const key = envRef[1] as string;
    const resolved = Bun.env[key];
    if (resolved === undefined) throw new Error(`channel token "${ref}" is unset (env ${key} not defined)`);
    return resolved;
  }
  const secretRef = ref.match(/^\$\{secret:channel\/([^/]+)\/token\}$/);
  if (secretRef) {
    const id = secretRef[1] as string;
    const token = auth.channelCredentials?.[id]?.token;
    if (!token) throw new Error(`channel token "${ref}" is unset (no auth.json credential for channel ${id})`);
    return token;
  }
  return ref;
}
