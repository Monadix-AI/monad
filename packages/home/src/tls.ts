import { chmod, mkdir, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

export interface TlsCert {
  certPath: string;
  keyPath: string;
}

/** Try each candidate in order; return the first one that reports a version. */
export async function findOpenssl(): Promise<string | null> {
  const candidates =
    process.platform === 'win32'
      ? [
          'openssl',
          'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe',
          'C:\\Program Files\\Git\\usr\\bin\\openssl.exe'
        ]
      : ['openssl'];

  for (const cmd of candidates) {
    const r = Bun.spawnSync([cmd, 'version'], { stdout: 'ignore', stderr: 'ignore' });
    if (r.exitCode === 0) return cmd;
  }
  return null;
}

/**
 * Ensure a self-signed TLS certificate exists in `tlsDir`. Generates one with openssl if
 * neither cert.pem nor key.pem are present. Reuses existing files on subsequent calls so
 * restarts don't rotate the cert (browsers would lose their trust decision).
 *
 * Throws if openssl is not available or generation fails.
 */
export async function ensureTlsCert(tlsDir: string): Promise<TlsCert> {
  await mkdir(tlsDir, { recursive: true });
  const certPath = join(tlsDir, 'cert.pem');
  const keyPath = join(tlsDir, 'key.pem');

  if ((await Bun.file(certPath).exists()) && (await Bun.file(keyPath).exists())) {
    return { certPath, keyPath };
  }

  const openssl = await findOpenssl();
  if (!openssl) throw new Error('openssl not found');

  const host = (() => {
    try {
      return hostname();
    } catch {
      return 'localhost';
    }
  })();

  // Write a temp config so SAN works on all OpenSSL versions (1.0.2+).
  const cfgPath = join(tlsDir, 'gen.cnf');
  await Bun.write(
    cfgPath,
    [
      '[req]',
      'distinguished_name = req_dn',
      'x509_extensions = v3_req',
      'prompt = no',
      '',
      '[req_dn]',
      'CN = monad-daemon',
      '',
      '[v3_req]',
      `subjectAltName = IP:127.0.0.1,IP:::1,DNS:localhost,DNS:${host}`
    ].join('\n')
  );

  try {
    const result = Bun.spawnSync(
      [
        openssl,
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '3650',
        '-config',
        cfgPath
      ],
      { stderr: 'pipe' }
    );
    if (result.exitCode !== 0) {
      const detail = new TextDecoder().decode(result.stderr ?? new Uint8Array()).trim();
      throw new Error(`openssl exited ${result.exitCode}${detail ? `: ${detail}` : ''}`);
    }
  } finally {
    await unlink(cfgPath).catch(() => {});
  }

  // Private key: owner-read only. Cert is public.
  if (process.platform !== 'win32') {
    await chmod(keyPath, 0o600);
  }

  return { certPath, keyPath };
}

/**
 * Force-regenerate the TLS certificate: removes existing files then delegates to `ensureTlsCert`.
 * Use this when the cert has expired, its SANs have changed, or you want to rotate.
 * The daemon must be restarted after renewal for the new cert to take effect.
 */
export async function renewTlsCert(tlsDir: string): Promise<TlsCert> {
  const certPath = join(tlsDir, 'cert.pem');
  const keyPath = join(tlsDir, 'key.pem');
  await Promise.all([unlink(certPath).catch(() => {}), unlink(keyPath).catch(() => {})]);
  return ensureTlsCert(tlsDir);
}

/**
 * Return the ISO-8601 expiry timestamp (notAfter) of a PEM certificate.
 * Throws if openssl is not available or the file cannot be read.
 */
export async function certExpiry(certPath: string): Promise<string> {
  const openssl = await findOpenssl();
  if (!openssl) throw new Error('openssl not found');

  const result = Bun.spawnSync([openssl, 'x509', '-noout', '-enddate', '-in', certPath], {
    stdout: 'pipe',
    stderr: 'ignore'
  });
  if (result.exitCode !== 0) throw new Error(`openssl x509 exited ${result.exitCode}`);

  const out = new TextDecoder().decode(result.stdout ?? new Uint8Array()).trim();
  // Output: "notAfter=Jun 17 12:34:56 2036 GMT"
  const dateStr = out.replace(/^notAfter=/i, '').trim();
  return new Date(dateStr).toISOString();
}

/**
 * Return the SHA-256 fingerprint of a PEM certificate in `AA:BB:CC:…` colon-hex form.
 * Throws if openssl is not available or the file cannot be read.
 */
export async function certFingerprint(certPath: string): Promise<string> {
  const openssl = await findOpenssl();
  if (!openssl) throw new Error('openssl not found');

  const result = Bun.spawnSync([openssl, 'x509', '-fingerprint', '-sha256', '-noout', '-in', certPath], {
    stdout: 'pipe',
    stderr: 'ignore'
  });
  if (result.exitCode !== 0) throw new Error(`openssl x509 exited ${result.exitCode}`);

  const out = new TextDecoder().decode(result.stdout ?? new Uint8Array()).trim();
  // Output format: "sha256 Fingerprint=AA:BB:CC:..." (OpenSSL 3) or "SHA256 Fingerprint=..." (1.x)
  const eq = out.indexOf('=');
  return eq >= 0 ? out.slice(eq + 1) : out;
}
