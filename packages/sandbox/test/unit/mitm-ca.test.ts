import { describe, expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import forge from 'node-forge';

import { createMitmCA, disposeMitmCA } from '../../src/mitm/ca.ts';

describe('mitm CA', () => {
  test('generates an ephemeral CA with a 0o600 key and a readable cert', () => {
    const ca = createMitmCA();
    try {
      expect(existsSync(ca.caCertPath)).toBe(true);
      expect(existsSync(ca.caKeyPath)).toBe(true);
      // Key must be owner-only; cert is public trust material.
      expect(statSync(ca.caKeyPath).mode & 0o777).toBe(0o600);
      expect(statSync(ca.caCertPath).mode & 0o777).toBe(0o644);
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
});
