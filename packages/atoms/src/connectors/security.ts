// A webhook URL is an unauthenticated entry point — every payload MUST be verified
// against the shared secret before ingestion. See docs/security-guidelines.md §6.

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface WebhookSignatureInput {
  /** Shared secret configured for this webhook source. */
  secret: string;
  /** The EXACT raw request body bytes/text the signature was computed over. */
  payload: string | Uint8Array;
  /** The signature the sender supplied (hex; an optional `sha256=` prefix is tolerated). */
  signature: string;
  /** HMAC hash algorithm. Default sha256. */
  algorithm?: string;
}

/**
 * Constant-time HMAC verification. Must compare against the RAW body bytes —
 * re-serializing parsed JSON changes byte sequences and breaks the HMAC.
 */
export function verifyWebhookSignature({
  secret,
  payload,
  signature,
  algorithm = 'sha256'
}: WebhookSignatureInput): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac(algorithm, secret).update(payload).digest('hex');
  // GitHub/Stripe send `sha256=<hex>`; strip the prefix and normalize case.
  const provided = signature
    .trim()
    .toLowerCase()
    .replace(/^[a-z0-9]+=/, '');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  // timingSafeEqual throws on unequal lengths; a hex digest length is non-secret so early return is safe.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
