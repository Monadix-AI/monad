// Shared RS256 JWT verification using Web Crypto (zero runtime deps).
// JWKS keys are fetched once and cached for 5 minutes; cache is busted on unknown kid.

import { z } from 'zod';

const jwkKeySchema = z.object({
  kty: z.string(),
  use: z.string().optional(),
  kid: z.string().optional(),
  n: z.string().optional(),
  e: z.string().optional(),
  alg: z.string().optional()
});
type JwkKey = z.infer<typeof jwkKeySchema>;

const jwksSchema = z.object({ keys: z.array(jwkKeySchema) });

const jwtHeaderSchema = z.object({ alg: z.string().optional(), kid: z.string().optional() });

const jwksCache = new Map<string, { keys: JwkKey[]; fetchedAt: number }>();
const JWKS_TTL_MS = 5 * 60 * 1000;

async function fetchJwks(url: string, signal?: AbortSignal): Promise<JwkKey[]> {
  const cached = jwksCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`jwt: JWKS fetch failed: ${res.status}`);
  const json = jwksSchema.parse(await res.json());
  jwksCache.set(url, { keys: json.keys, fetchedAt: Date.now() });
  return json.keys;
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const padded = s
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(s.length + ((4 - (s.length % 4)) % 4), '=');
  const bin = atob(padded);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function rsaKeyFromJwk(jwk: JwkKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
}

const jwtClaimsSchema = z
  .object({
    iss: z.string().optional(),
    aud: z.union([z.string(), z.array(z.string())]).optional(),
    exp: z.number().optional(),
    nbf: z.number().optional()
  })
  .loose();
export type JwtClaims = z.infer<typeof jwtClaimsSchema>;

export interface JwtVerifyOptions {
  jwksUrl: string;
  issuer: string;
  audience: string;
  /** Max clock skew in seconds (default 300). */
  clockSkewSec?: number;
  signal?: AbortSignal;
}

/** Verify an RS256 Bearer JWT against a JWKS endpoint. Throws on any failure. */
export async function verifyJwt(token: string, opts: JwtVerifyOptions): Promise<JwtClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('jwt: malformed token');
  const [headerB64, payloadB64, sigB64] = parts;

  const header = jwtHeaderSchema.parse(JSON.parse(new TextDecoder().decode(b64urlToBytes(headerB64 ?? ''))));
  if (header.alg !== 'RS256') throw new Error(`jwt: unsupported alg ${header.alg}`);

  let keys = await fetchJwks(opts.jwksUrl, opts.signal);
  let key = header.kid ? keys.find((k) => k.kid === header.kid) : keys[0];
  if (!key) {
    // Bust the cache and retry once — key may have just rotated.
    jwksCache.delete(opts.jwksUrl);
    keys = await fetchJwks(opts.jwksUrl, opts.signal);
    key = header.kid ? keys.find((k) => k.kid === header.kid) : keys[0];
  }
  if (!key) throw new Error(`jwt: unknown kid "${header.kid}"`);

  const cryptoKey = await rsaKeyFromJwk(key);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    b64urlToBytes(sigB64 ?? ''),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  if (!valid) throw new Error('jwt: signature invalid');

  const claims = jwtClaimsSchema.parse(JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64 ?? ''))));

  const now = Math.floor(Date.now() / 1000);
  const skew = opts.clockSkewSec ?? 300;
  if (typeof claims.exp === 'number' && claims.exp + skew < now) throw new Error('jwt: token expired');
  if (typeof claims.nbf === 'number' && claims.nbf - skew > now) throw new Error('jwt: token not yet valid');
  if (claims.iss !== opts.issuer) throw new Error(`jwt: unexpected issuer "${claims.iss}"`);

  const aud = Array.isArray(claims.aud) ? claims.aud : typeof claims.aud === 'string' ? [claims.aud] : [];
  if (!aud.includes(opts.audience)) throw new Error(`jwt: unexpected audience ${JSON.stringify(claims.aud)}`);

  return claims;
}
