import { createHash } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The daemon accepts `idem_` + exactly 12 alphanumerics (transports/http/idempotency.ts). */
function encode(digest: Buffer): string {
  let out = '';
  for (let i = 0; i < 12; i++) out += ALPHABET[(digest[i] ?? 0) % ALPHABET.length];
  return `idem_${out}`;
}

/**
 * A content-derived idempotency key for a write.
 *
 * Deliberately deterministic rather than random: the retry this protects against is a *script*
 * re-running the same command (a wrapper retry, a re-queued job, a flaky pipe), and a fresh random
 * key per invocation would sail straight past the daemon's ledger and bill a second turn. Hashing
 * the request identity means an identical re-run inside the daemon's 5-minute window replays the
 * first response, while any change to the payload produces a different key and a genuinely new
 * request. `--idempotency-key` overrides this when a caller wants to scope replays itself.
 */
function autoIdempotencyKey(scope: string, parts: readonly (string | undefined)[]): string {
  const hash = createHash('sha256').update(scope);
  for (const part of parts) hash.update('\0').update(part ?? '');
  return encode(hash.digest());
}

/** Resolve the header value for a write: an explicit `--idempotency-key` wins over the derived one. */
export function idempotencyHeaders(
  flags: Record<string, unknown>,
  scope: string,
  parts: readonly (string | undefined)[]
): Record<string, string> {
  const explicit = flags['idempotency-key'] ?? flags.idempotencyKey;
  const key = typeof explicit === 'string' && explicit ? explicit : autoIdempotencyKey(scope, parts);
  return { 'idempotency-key': key };
}
