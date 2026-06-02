// Boot phase: ensure the daemon has a self-signed TLS certificate for its primary HTTPS listener.
// The daemon is HTTPS-first even for loopback TCP; a separate local-only HTTP fallback listener can
// be enabled for compatibility, but certificate provisioning itself is fail-closed.

import type { MonadConfig, MonadPaths } from '@monad/environment';

import { certExpiry, certFingerprint, ensureTlsCert, findOpenssl, renewTlsCert } from '@monad/environment';

export interface TlsSetup {
  cert?: { certPath: string; keyPath: string };
  fingerprint?: string;
  expiry?: string;
  /** Surfaced in the daemon status (e.g. 'tls:cert-renewed'). */
  warnings: string[];
}

// Injected so the fail-closed branches (openssl absent, cert generation failure) are testable
// without a real openssl on the host.
export interface TlsDeps {
  findOpenssl: typeof findOpenssl;
  ensureTlsCert: typeof ensureTlsCert;
  renewTlsCert: typeof renewTlsCert;
  certExpiry: typeof certExpiry;
}

export async function createTlsCert(
  opts: {
    tlsDir: MonadPaths['tls'];
    renewBeforeDays?: number;
  },
  deps: TlsDeps = { findOpenssl, ensureTlsCert, renewTlsCert, certExpiry }
): Promise<TlsSetup> {
  const warnings: string[] = [];

  const opensslPath = await deps.findOpenssl();
  if (!opensslPath) {
    throw new Error(
      'monad: openssl is not installed — cannot provision the daemon HTTPS certificate.\n' +
        'Install openssl (e.g. `brew install openssl` / `apt install openssl`) and restart.'
    );
  }

  try {
    let cert = await deps.ensureTlsCert(opts.tlsDir);
    let expiry: string | undefined;
    try {
      expiry = await deps.certExpiry(cert.certPath);
      const renewBeforeMs = (opts.renewBeforeDays ?? 30) * 86_400_000;
      if (new Date(expiry).getTime() - Date.now() <= renewBeforeMs) {
        cert = await deps.renewTlsCert(opts.tlsDir);
        warnings.push('tls:cert-renewed');
        expiry = await deps.certExpiry(cert.certPath).catch(() => undefined);
      }
    } catch {
      cert = await deps.renewTlsCert(opts.tlsDir);
      warnings.push('tls:cert-renewed');
      expiry = await deps.certExpiry(cert.certPath).catch(() => undefined);
    }

    const fingerprint = await certFingerprint(cert.certPath).catch(() => undefined);
    return { cert, fingerprint, expiry, warnings };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `monad: TLS certificate generation failed (${msg}).\n` +
        'Fix the openssl error and restart; the daemon primary TCP listener requires HTTPS.'
    );
  }
}

export async function resolveTlsSetupForNetwork(opts: {
  https: MonadConfig['network']['https'];
  tlsDir: MonadPaths['tls'];
  current?: TlsSetup;
  provision?: typeof createTlsCert;
}): Promise<TlsSetup> {
  if (!opts.https.enabled) return { warnings: ['tls:https-disabled'] };
  if (opts.current?.cert) return opts.current;
  return (opts.provision ?? createTlsCert)({ tlsDir: opts.tlsDir });
}
