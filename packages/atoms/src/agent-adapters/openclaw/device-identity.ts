import crypto from 'node:crypto';

// OpenClaw's gateway authorizes a connection's *scopes* (e.g. `operator.write`, required for
// `sessions.create`/`sessions.send`) from a device SIGNATURE, not from the shared token alone — a
// token-only connect is accepted but granted an empty scope set. This reproduces OpenClaw's own
// device-identity + `buildDeviceAuthPayloadV3` scheme (verified against its shipped
// `dist/device-identity-*.js` / `dist/client-*.js`) so the adapter can sign the connect challenge and
// obtain operator scopes without OpenClaw's interactive `devices approve` pairing step.
//
// The identity is generated fresh per session and kept in memory only: the daemon spawns a dedicated,
// ephemeral gateway per session, so there is no cross-session identity to persist — and persisting a
// long-lived signing key would be a credential to secure for no benefit.

// SubjectPublicKeyInfo DER prefix for an Ed25519 public key (RFC 8410); the 32 raw key bytes follow it.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function rawPublicKeyFromPem(publicKeyPem: string): Buffer {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
    ? spki.subarray(ED25519_SPKI_PREFIX.length)
    : spki;
}

export interface OpenClawDeviceIdentity {
  /** `sha256(rawPublicKey)` hex — OpenClaw's stable device id derivation. */
  deviceId: string;
  /** The 32 raw Ed25519 public-key bytes, base64url-encoded (the connect frame's `device.publicKey`). */
  publicKeyRawBase64Url: string;
  privateKeyPem: string;
}

export function createOpenClawDeviceIdentity(): OpenClawDeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const raw = rawPublicKeyFromPem(publicKeyPem);
  return {
    deviceId: crypto.createHash('sha256').update(raw).digest('hex'),
    publicKeyRawBase64Url: base64Url(raw),
    privateKeyPem
  };
}

// OpenClaw's `normalizeDeviceMetadataForAuth`: trim + lowercase ASCII. The signed payload and the
// gateway must agree byte-for-byte, so platform/deviceFamily are normalized identically on both sides.
function normalizeMetadata(value: string | undefined): string {
  if (!value) return '';
  return value.trim().replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}

export interface OpenClawDeviceAuthPayloadParams {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  /** The shared gateway token when one is configured, else `''`. It is part of the signed material —
   *  a token-mode gateway rejects a signature computed with an empty token as `DEVICE_AUTH_SIGNATURE_INVALID`. */
  token: string;
  nonce: string;
  platform: string;
}

/** Reproduce OpenClaw's `buildDeviceAuthPayloadV3` canonical string exactly (field order, `|` join,
 *  normalized platform/deviceFamily). The gateway verifies the Ed25519 signature over this string. */
export function buildDeviceAuthPayloadV3(params: OpenClawDeviceAuthPayloadParams): string {
  return [
    'v3',
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(','),
    String(params.signedAtMs),
    params.token,
    params.nonce,
    normalizeMetadata(params.platform),
    '' // deviceFamily — unused for a headless orchestrator
  ].join('|');
}

/** Ed25519-sign a UTF-8 payload with a PEM private key, returning base64url bytes (OpenClaw
 *  `signDevicePayload`). Ed25519 uses a null digest algorithm in `crypto.sign`. */
export function signDevicePayload(privateKeyPem: string, payload: string): string {
  return base64Url(crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(privateKeyPem)));
}

/** Reconstruct a usable public key from the raw base64url bytes the connect frame's `device.publicKey`
 *  carries (the reverse of `createOpenClawDeviceIdentity`'s derivation) — used to verify a signature
 *  produced by `signDevicePayload` against the identity that produced it. */
export function publicKeyFromRawBase64Url(rawBase64Url: string): crypto.KeyObject {
  const raw = Buffer.from(rawBase64Url.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  return crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}
