// Per-session sentinel registry for credential masking (env-based).
//
// A masked credential's real value is replaced inside the sandbox with a sentinel of the form
// `fake_value_<uuid4>`. The confined child sees only the sentinel; the host-side TLS-terminating
// proxy substitutes sentinel→real on the outbound (proxy→server) leg, and ONLY when the destination
// host matches that credential's own injectHosts. A prompt-injected exfil to any other host therefore
// carries the useless fake, never the real secret. The real value lives ONLY in this in-memory map —
// it is never written to disk and never logged.

import { randomUUID } from 'node:crypto';

import { domainMatches } from './egress-policy.ts';

export const SENTINEL_PREFIX = 'fake_value_';

export interface SentinelCredential {
  readonly name: string;
  readonly childValue?: string;
  readonly substitutions: readonly SentinelSubstitution[];
}

export interface SentinelSubstitution {
  readonly fake: string;
  readonly real: string;
  readonly injectHosts: readonly string[];
}

/**
 * Sentinel↔real-value map, keyed by credential name.
 *
 * Substitution is gated per sentinel: a sentinel is swapped to its real value only when the
 * destination matches THAT credential's hosts. This prevents laundering credential A through
 * credential B's allowlisted host — the proxy leaves A's sentinel intact on B's host.
 *
 * Keying on name (not value) means two env vars holding the same secret get distinct sentinels, each
 * with an independent host list.
 */
export class SentinelRegistry {
  private readonly byName = new Map<string, SentinelCredential>();

  /**
   * Register `name` with its real value and injectHosts, minting a fresh `fake_value_<uuid4>`
   * sentinel and returning it. The sentinel is free of shell/URL metacharacters so it survives
   * `--setenv`/`env NAME=value` unquoted. Idempotent on `name`: a repeat call re-mints with the new
   * values (the caller controls lifecycle).
   */
  register(name: string, realValue: string, injectHosts: string[]): string {
    const sentinel = SENTINEL_PREFIX + randomUUID();
    // Strip CR/LF: the real value is substituted into a CRLF-joined header block on the outbound leg,
    // so an embedded newline could forge a header line. A credential never legitimately contains one.
    const clean = realValue.replace(/[\r\n]/g, '');
    this.registerMaterialized(name, sentinel, [{ fake: sentinel, real: clean, injectHosts }]);
    return sentinel;
  }

  registerMaterialized(name: string, childValue: string, substitutions: readonly SentinelSubstitution[]): void {
    this.store(name, childValue, substitutions);
  }

  registerSubstitutions(name: string, substitutions: readonly SentinelSubstitution[]): void {
    this.store(name, undefined, substitutions);
  }

  private store(name: string, childValue: string | undefined, substitutions: readonly SentinelSubstitution[]): void {
    this.byName.set(name, {
      name,
      childValue,
      substitutions: substitutions.map((substitution) => ({
        ...substitution,
        real: substitution.real.replace(/[\r\n]/g, '')
      }))
    });
  }

  /** Env map `{ [name]: sentinel }` to inject into the confined child. Never carries a real value. */
  childEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const c of this.byName.values()) {
      if (c.childValue !== undefined) env[c.name] = c.childValue;
    }
    return env;
  }

  /** Number of registered credentials. */
  get size(): number {
    return this.byName.size;
  }

  /**
   * Replace, in `text`, every registered sentinel with its real value — but only for credentials
   * whose `injectHosts` cover `host` (exact or subdomain, via egress-policy's domainMatches). A
   * credential whose host list does not match `host` is left as its sentinel. Returns the rewritten
   * text. `text` is expected to be an outbound request-head (request line + headers) on the
   * proxy→server leg only, so the real value never reaches the child or the response.
   */
  substitute(host: string, text: string): string {
    if (this.byName.size === 0) return text;
    let out = text;
    for (const c of this.byName.values()) {
      for (const substitution of c.substitutions) {
        if (!out.includes(substitution.fake)) continue;
        if (!substitution.injectHosts.some((pattern) => domainMatches(host, pattern))) continue;
        out = out.split(substitution.fake).join(substitution.real);
      }
    }
    return out;
  }
}
