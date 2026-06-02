// Boot phase: auto-generate the self-signed TLS cert for remote access (HTTPS protects the bearer
// token in transit). Fail-closed by default: if openssl is absent or cert generation fails, the
// daemon refuses to start when remote access is enabled. Set allowInsecureHttp=true in config only
// when deploying behind an external TLS terminator. Returns cert paths + fingerprint/expiry for the
// ready-info banner, and warning codes for the daemon status.

import type { MonadPaths } from '@monad/home';

import { certExpiry, certFingerprint, ensureTlsCert, findOpenssl } from '@monad/home';
import { logger } from '@monad/logger';

export interface TlsSetup {
  cert?: { certPath: string; keyPath: string };
  fingerprint?: string;
  expiry?: string;
  /** Surfaced in the daemon status (e.g. 'tls:openssl-not-found', 'tls:cert-error'). */
  warnings: string[];
}

// Injected so the fail-closed branches (openssl absent, cert generation failure) are testable
// without a real openssl on the host.
export interface TlsDeps {
  findOpenssl: typeof findOpenssl;
  ensureTlsCert: typeof ensureTlsCert;
}

export async function createTlsCert(
  opts: {
    enabled: boolean;
    tlsDir: MonadPaths['tls'];
    allowInsecureHttp?: boolean;
  },
  deps: TlsDeps = { findOpenssl, ensureTlsCert }
): Promise<TlsSetup> {
  const warnings: string[] = [];
  if (!opts.enabled) return { warnings };

  const opensslPath = await deps.findOpenssl();
  if (!opensslPath) {
    if (!opts.allowInsecureHttp) {
      throw new Error(
        'monad: remote access is enabled but openssl is not installed — cannot provision TLS.\n' +
          'Install openssl (e.g. `brew install openssl` / `apt install openssl`) and restart, or ' +
          'set network.remoteAccess.allowInsecureHttp=true in config.json if you are deploying ' +
          'behind a TLS-terminating reverse proxy.'
      );
    }
    logger.warn(
      'monad: openssl not found — remote access running over plain HTTP (allowInsecureHttp=true). ' +
        'The bearer token is transmitted unencrypted. Deploy behind a TLS proxy or install openssl.'
    );
    warnings.push('tls:openssl-not-found');
    return { warnings };
  }

  try {
    const cert = await deps.ensureTlsCert(opts.tlsDir);
    const [fingerprint, expiry] = await Promise.all([
      certFingerprint(cert.certPath).catch(() => undefined),
      certExpiry(cert.certPath).catch(() => undefined)
    ]);
    return { cert, fingerprint, expiry, warnings };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!opts.allowInsecureHttp) {
      throw new Error(
        `monad: remote access is enabled but TLS certificate generation failed (${msg}).\n` +
          'Fix the openssl error and restart, or set network.remoteAccess.allowInsecureHttp=true ' +
          'in config.json if you are deploying behind a TLS-terminating reverse proxy.'
      );
    }
    logger.warn(
      `monad: TLS certificate generation failed (${msg}) — remote access running over plain HTTP (allowInsecureHttp=true).`
    );
    warnings.push('tls:cert-error');
    return { warnings };
  }
}
