import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import forge from 'node-forge';

import { createMitmCA, disposeMitmCA } from '../../src/mitm/ca.ts';

describe('mitm CA', () => {
  test('generates a readable ephemeral CA certificate and private key', () => {
    const ca = createMitmCA();
    try {
      const cert = forge.pki.certificateFromPem(readFileSync(ca.caCertPath, 'utf8'));
      const key = forge.pki.privateKeyFromPem(readFileSync(ca.caKeyPath, 'utf8'));
      if (!('n' in key) || !('n' in cert.publicKey)) throw new Error('expected RSA key pair');
      expect({
        commonName: cert.subject.getField('CN')?.value,
        matchingPublicKey: forge.pki.rsa.setPublicKey(key.n, key.e).n.compareTo(cert.publicKey.n) === 0
      }).toEqual({ commonName: 'monad sandbox ephemeral CA', matchingPublicKey: true });
    } finally {
      void disposeMitmCA(ca);
    }
  });

  test('mints a leaf for example.com signed by the CA with a matching SAN', () => {
    const ca = createMitmCA();
    try {
      const leaf = ca.leafForHost('example.com');
      const caCert = forge.pki.certificateFromPem(require('node:fs').readFileSync(ca.caCertPath, 'utf8'));
      const leafCert = forge.pki.certificateFromPem(leaf.cert);

      // Chain: the CA's public key verifies the leaf's signature.
      expect(caCert.verify(leafCert)).toBe(true);

      // SAN carries the host as a dNSName.
      const san = leafCert.getExtension('subjectAltName') as { altNames?: Array<{ type: number; value?: string }> };
      const dnsNames = (san.altNames ?? []).filter((n) => n.type === 2).map((n) => n.value);
      expect(dnsNames).toContain('example.com');

      // Leaf is not a CA and is issued by our CA subject.
      const bc = leafCert.getExtension('basicConstraints') as { cA?: boolean };
      expect(bc.cA).toBe(false);
      expect(leafCert.issuer.getField('CN')?.value).toBe(caCert.subject.getField('CN')?.value);
    } finally {
      void disposeMitmCA(ca);
    }
  });

  test('caches leaf per host (same object returned)', () => {
    const ca = createMitmCA();
    try {
      expect(ca.leafForHost('example.com')).toBe(ca.leafForHost('example.com'));
    } finally {
      void disposeMitmCA(ca);
    }
  });

  test('dispose removes the ephemeral temp dir', async () => {
    const ca = createMitmCA();
    const dir = dirname(ca.caCertPath);
    expect(existsSync(dir)).toBe(true);
    await disposeMitmCA(ca);
    expect(existsSync(dir)).toBe(false);
  });

  test('supplying only one of caCertPath/caKeyPath is an error', () => {
    expect(() => createMitmCA({ caCertPath: '/tmp/only-cert.pem' })).toThrow(/must be provided together/);
    expect(() => createMitmCA({ caKeyPath: '/tmp/only-key.pem' })).toThrow(/must be provided together/);
  });

  test.each(['before_directory', 'after_directory', 'before_cert_write', 'before_key_write'] as const)(
    'ephemeral generation failure at %s is stable and removes partial artifacts',
    (testFailureStage) => {
      const root = mkdtempSync(join(tmpdir(), 'mitm-ca-failure-test-'));
      try {
        let message = '';
        try {
          createMitmCA({ testFailureStage, tempRoot: root });
        } catch (error) {
          message = (error as Error).message;
        }
        expect({ message, directories: readdirSync(root) }).toEqual({
          message: 'tls_terminate_ca_generation_failed',
          directories: []
        });
        expect(message).not.toContain('/');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );
});
