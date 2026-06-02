/**
 * Secret masking for anything the CLI reads straight off disk.
 *
 * The daemon already redacts credentials in its settings responses, but `monad config` is a local
 * command: it parses `config.json` itself so it keeps working with the daemon down, which walks
 * around that masking entirely. Without this, `monad config list` prints live provider API keys to
 * stdout — into CI logs, pasted bug reports, and `--json` pipes.
 *
 * Matching is by key name rather than by a list of known paths: the config schema grows, and a new
 * secret field must be masked the day it lands, not the day someone remembers to update a path list.
 */

const SECRET_KEY = /(token|secret|password|passphrase|^key$|[a-z]key$|apikey|credential)/i;

/** Keys that read as secret-ish but hold no secret; masking them would hide useful config. */
const NOT_SECRET = new Set(['tokenLimit', 'tokensLimit', 'maxThinkingTokens', 'credentialIds', 'keyOptional']);

function isSecretKey(key: string): boolean {
  return !NOT_SECRET.has(key) && SECRET_KEY.test(key);
}

/** Keep enough of the value to recognise which credential it is, never enough to use it. */
export function maskSecret(value: string): string {
  if (!value) return value;
  return value.length <= 8 ? '••••' : `••••${value.slice(-4)}`;
}

/** Recursively mask every secret-named leaf, preserving structure so output stays diffable. */
export function redactSecrets<T>(value: T, parentKey = ''): T {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, parentKey)) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        isSecretKey(key) && typeof item === 'string' ? maskSecret(item) : redactSecrets(item, key)
      ])
    ) as unknown as T;
  }
  // A secret reached through a path whose own leaf key matched (e.g. `config get openaiCompat.token`
  // hands us the bare string).
  if (typeof value === 'string' && isSecretKey(parentKey)) return maskSecret(value) as unknown as T;
  return value;
}
