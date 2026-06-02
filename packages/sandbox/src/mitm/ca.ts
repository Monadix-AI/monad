// MITM certificate authority for the TLS-terminating egress proxy.
//
// The CA is either loaded from disk (network.tlsTerminate.{caCertPath,caKeyPath}) or, by default,
// generated as an EPHEMERAL RSA-2048 self-signed CA into a fresh per-process temp dir. The cert is
// written world-readable (it is public trust material — the sandboxed child's trust env points at
// it), the private key is chmod 0o600, and the whole temp dir is removed by disposeMitmCA().
//
// Per-host leaf certs are minted lazily and cached for the CA's lifetime, so a client that trusts
// the CA accepts the proxy's leaf for that host. The CA private key is NEVER logged.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { logger } from '@monad/logger';
import forge from 'node-forge';

const { pki, md, random, util } = forge;

export interface MitmLeaf {
  /** Leaf cert PEM followed by the CA cert PEM (full chain the terminating server presents). */
  cert: string;
  /** Leaf private key PEM. */
  key: string;
}

export interface MitmCA {
  /** Filesystem path to the CA certificate (PEM) — what the child's trust env vars point at. */
  readonly caCertPath: string;
  /** Filesystem path to the CA private key (PEM, chmod 0o600). Never logged, never handed to the child. */
  readonly caKeyPath: string;
  /** Mint (or return the cached) leaf certificate for `host`, signed by this CA. */
  leafForHost(host: string): MitmLeaf;
}

export interface CreateMitmCAOptions {
  /** Load an existing CA cert from this PEM path. Must be given together with caKeyPath. */
  caCertPath?: string;
  /** Load the CA private key from this PEM path. Must be given together with caCertPath. */
  caKeyPath?: string;
  testFailureStage?: 'before_directory' | 'after_directory' | 'before_cert_write' | 'before_key_write';
  tempRoot?: string;
}

interface MitmCAInternal extends MitmCA {
  readonly _cert: forge.pki.Certificate;
  readonly _key: forge.pki.rsa.PrivateKey;
  readonly _caCertPem: string;
  readonly _leafCache: Map<string, MitmLeaf>;
  readonly _ephemeral: boolean;
}

/**
 * Create a MitmCA. When both `caCertPath` and `caKeyPath` are supplied, load them from disk; when
 * both are omitted, generate an ephemeral RSA-2048 self-signed CA into a fresh temp dir. Supplying
 * exactly one is an error (a cert without its key, or vice versa, cannot sign leaves).
 */
export function createMitmCA(opts: CreateMitmCAOptions = {}): MitmCA {
  if (opts.caCertPath && opts.caKeyPath) return loadCA(opts.caCertPath, opts.caKeyPath);
  if (opts.caCertPath || opts.caKeyPath) {
    throw new Error('tls_terminate_ca_pair_required: caCertPath and caKeyPath must be provided together');
  }
  return generateEphemeralCA(opts);
}

/**
 * Remove the temp dir backing an ephemeral CA (cert + key + parent dir). A CA loaded from
 * user-supplied paths owns no temp dir, so dispose is a no-op for it. Best-effort: a cleanup
 * failure is logged, not thrown, so shutdown never hangs on it.
 */
export async function disposeMitmCA(ca: MitmCA): Promise<void> {
  const internal = ca as MitmCAInternal;
  if (!internal._ephemeral) return;
  internal._leafCache.clear();
  try {
    await rm(dirname(ca.caCertPath), { recursive: true, force: true });
  } catch {
    logger.warn('tls_terminate_ca_cleanup_failed');
  }
}

export function disposeMitmCASync(ca: MitmCA): void {
  const internal = ca as MitmCAInternal;
  if (!internal._ephemeral) return;
  internal._leafCache.clear();
  try {
    rmSync(dirname(ca.caCertPath), { recursive: true, force: true });
  } catch {
    logger.warn('tls_terminate_ca_cleanup_failed');
  }
}

function makeCA(
  cert: forge.pki.Certificate,
  key: forge.pki.rsa.PrivateKey,
  caCertPem: string,
  caCertPath: string,
  caKeyPath: string,
  ephemeral: boolean
): MitmCA {
  const leafCache = new Map<string, MitmLeaf>();
  const ca: MitmCAInternal = {
    caCertPath,
    caKeyPath,
    _cert: cert,
    _key: key,
    _caCertPem: caCertPem,
    _leafCache: leafCache,
    _ephemeral: ephemeral,
    leafForHost(host: string): MitmLeaf {
      const cached = leafCache.get(host);
      if (cached) return cached;
      const leaf = mintLeaf(ca, host);
      leafCache.set(host, leaf);
      return leaf;
    }
  };
  return ca;
}

function generateEphemeralCA(opts: CreateMitmCAOptions): MitmCA {
  let dir: string | undefined;
  try {
    if (opts.testFailureStage === 'before_directory') throw new Error('injected');
    dir = mkdtempSync(join(opts.tempRoot ?? tmpdir(), 'monad-mitm-ca-'));
    if (opts.testFailureStage === 'after_directory') throw new Error('injected');

    const keys = pki.rsa.generateKeyPair(2048);
    const cert = pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = randomSerial();
    cert.validity.notBefore = daysFromNow(-1);
    cert.validity.notAfter = daysFromNow(825);
    const subject = [
      { name: 'commonName', value: 'monad sandbox ephemeral CA' },
      { name: 'organizationName', value: 'monad-sandbox' }
    ];
    cert.setSubject(subject);
    cert.setIssuer(subject);
    cert.setExtensions([
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', critical: true, keyCertSign: true, cRLSign: true, digitalSignature: true },
      { name: 'subjectKeyIdentifier' }
    ]);
    cert.sign(keys.privateKey, md.sha256.create());

    const caCertPem = pki.certificateToPem(cert);
    const caKeyPem = pki.privateKeyToPem(keys.privateKey);
    const caCertPath = join(dir, 'ca.crt');
    const caKeyPath = join(dir, 'ca.key');
    if (opts.testFailureStage === 'before_cert_write') throw new Error('injected');
    writeFileSync(caCertPath, caCertPem, { mode: 0o644 });
    if (opts.testFailureStage === 'before_key_write') throw new Error('injected');
    writeFileSync(caKeyPath, caKeyPem, { mode: 0o600 });

    logger.info('tls_terminate_ca_generated');
    return makeCA(cert, keys.privateKey, caCertPem, caCertPath, caKeyPath, true);
  } catch {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        logger.warn('tls_terminate_ca_cleanup_failed');
      }
    }
    throw new Error('tls_terminate_ca_generation_failed');
  }
}

function loadCA(caCertPath: string, caKeyPath: string): MitmCA {
  const certPem = readPem(caCertPath, 'CERTIFICATE', 'tlsTerminate.caCertPath');
  const keyPem = readPem(caKeyPath, 'PRIVATE KEY', 'tlsTerminate.caKeyPath');
  let cert: forge.pki.Certificate;
  let key: forge.pki.PrivateKey;
  try {
    cert = pki.certificateFromPem(certPem);
    key = pki.privateKeyFromPem(keyPem);
  } catch {
    throw new Error('tls_terminate_ca_parse_failed');
  }
  // node-forge can only sign with an RSA private key (n/d present).
  if (!('n' in key) || !('d' in key)) {
    throw new Error('tls_terminate_ca_key_unsupported');
  }
  logger.info('tls_terminate_ca_loaded');
  return makeCA(cert, key as forge.pki.rsa.PrivateKey, certPem, caCertPath, caKeyPath, false);
}

function readPem(path: string, label: string, field: string): string {
  let pem: string;
  try {
    pem = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`tls_terminate_ca_read_failed_${field === 'tlsTerminate.caCertPath' ? 'cert' : 'key'}`);
  }
  if (!new RegExp(`-----BEGIN [A-Z ]*${label}-----`).test(pem)) {
    throw new Error(`tls_terminate_ca_pem_invalid_${field === 'tlsTerminate.caCertPath' ? 'cert' : 'key'}`);
  }
  return pem;
}

function mintLeaf(ca: MitmCAInternal, host: string): MitmLeaf {
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  const notBefore = daysFromNow(-1);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = clampValidity(ca._cert, notBefore);
  cert.setSubject([{ name: 'commonName', value: host }]);
  cert.setIssuer(ca._cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', critical: true, digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [sanFor(host)] },
    { name: 'subjectKeyIdentifier' },
    // Python ≥3.13 (VERIFY_X509_STRICT) rejects a non-self-signed leaf without AKI; supply the CA's
    // subject key id. node-forge stores SKI as a hex string but expects AKI keyIdentifier as raw
    // bytes, so decode before passing it through.
    { name: 'authorityKeyIdentifier', keyIdentifier: caSubjectKeyId(ca._cert) }
  ]);
  cert.sign(ca._key, md.sha256.create());
  return {
    cert: pki.certificateToPem(cert) + ca._caCertPem,
    key: pki.privateKeyToPem(keys.privateKey)
  };
}

function sanFor(host: string): { type: number; value?: string; ip?: string } {
  // RFC 5280 GeneralName tags: 2 = dNSName, 7 = iPAddress.
  return isIP(host) !== 0 ? { type: 7, ip: host } : { type: 2, value: host };
}

// Leaf validity capped at min(CA notAfter, notBefore+99d); anchored at notBefore (which is backdated
// one day) so the span is exactly 99 days. 99d clears the CA/B baseline and macOS 825d ceilings.
function clampValidity(caCert: forge.pki.Certificate, notBefore: Date): Date {
  const caEnd = caCert.validity.notAfter;
  const max = new Date(notBefore);
  max.setDate(max.getDate() + 99);
  return caEnd < max ? new Date(caEnd) : max;
}

function caSubjectKeyId(caCert: forge.pki.Certificate): string {
  const ext = caCert.getExtension('subjectKeyIdentifier') as { subjectKeyIdentifier?: string } | undefined;
  return ext?.subjectKeyIdentifier
    ? util.hexToBytes(ext.subjectKeyIdentifier)
    : caCert.generateSubjectKeyIdentifier().getBytes();
}

function randomSerial(): string {
  // 16 random bytes; clear the high bit so the DER INTEGER stays positive.
  const hex = util.bytesToHex(random.getBytesSync(16));
  const firstNibble = parseInt(hex.slice(0, 1), 16) & 0x7;
  return firstNibble.toString(16) + hex.slice(1);
}

function daysFromNow(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}
