import { expect, test } from 'bun:test';
import crypto from 'node:crypto';

import {
  buildDeviceAuthPayloadV3,
  createOpenClawDeviceIdentity,
  publicKeyFromRawBase64Url,
  signDevicePayload
} from '../../src/agent-adapters/openclaw/device-identity.ts';

test('createOpenClawDeviceIdentity derives deviceId as sha256 of the raw public key', () => {
  const identity = createOpenClawDeviceIdentity();
  const raw = Buffer.from(identity.publicKeyRawBase64Url.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  expect(raw.length).toBe(32); // Ed25519 public keys are 32 bytes
  expect(identity.deviceId).toBe(crypto.createHash('sha256').update(raw).digest('hex'));
  expect(identity.privateKeyPem).toContain('BEGIN PRIVATE KEY');
});

test('each identity is unique (fresh Ed25519 keypair)', () => {
  expect(createOpenClawDeviceIdentity().deviceId).not.toBe(createOpenClawDeviceIdentity().deviceId);
});

test('buildDeviceAuthPayloadV3 matches OpenClaw canonical format (order, pipe-join, lowercased metadata)', () => {
  const payload = buildDeviceAuthPayloadV3({
    deviceId: 'dev1',
    clientId: 'cli',
    clientMode: 'cli',
    role: 'operator',
    scopes: ['operator.read', 'operator.write'],
    signedAtMs: 1700,
    token: 'tok',
    nonce: 'nn',
    platform: 'Darwin'
  });
  // v3|deviceId|clientId|clientMode|role|scopes(csv)|signedAt|token|nonce|platformLower|deviceFamily("")
  expect(payload).toBe('v3|dev1|cli|cli|operator|operator.read,operator.write|1700|tok|nn|darwin|');
});

test('signDevicePayload produces a base64url Ed25519 signature that verifies against the public key', () => {
  const identity = createOpenClawDeviceIdentity();
  const payload = buildDeviceAuthPayloadV3({
    deviceId: identity.deviceId,
    clientId: 'cli',
    clientMode: 'cli',
    role: 'operator',
    scopes: ['operator.read', 'operator.write'],
    signedAtMs: 42,
    token: '',
    nonce: 'challenge-nonce',
    platform: process.platform
  });
  const signature = signDevicePayload(identity.privateKeyPem, payload);
  expect(signature).not.toContain('='); // base64url, unpadded
  const sig = Buffer.from(signature.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  expect(
    crypto.verify(null, Buffer.from(payload, 'utf8'), publicKeyFromRawBase64Url(identity.publicKeyRawBase64Url), sig)
  ).toBe(true);
  // A tampered payload must fail verification.
  expect(
    crypto.verify(
      null,
      Buffer.from(`${payload}x`, 'utf8'),
      publicKeyFromRawBase64Url(identity.publicKeyRawBase64Url),
      sig
    )
  ).toBe(false);
});
