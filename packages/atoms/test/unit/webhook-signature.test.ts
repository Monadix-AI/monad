import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';

import { verifyWebhookSignature } from '../../src/connectors/security.ts';

const secret = 'shhh-secret';
const body = '{"event":"ping","id":42}';
const sign = (payload: string, s = secret) => createHmac('sha256', s).update(payload).digest('hex');

test('accepts a correct signature', () => {
  expect(verifyWebhookSignature({ secret, payload: body, signature: sign(body) })).toBe(true);
});

test('tolerates a `sha256=` prefix and mixed case', () => {
  expect(verifyWebhookSignature({ secret, payload: body, signature: `sha256=${sign(body).toUpperCase()}` })).toBe(true);
});

test('rejects a wrong signature', () => {
  expect(verifyWebhookSignature({ secret, payload: body, signature: sign(body, 'wrong-secret') })).toBe(false);
});

test('rejects a tampered payload (signature no longer matches)', () => {
  const sig = sign(body);
  expect(verifyWebhookSignature({ secret, payload: `${body} `, signature: sig })).toBe(false);
});

test('rejects empty secret or signature', () => {
  expect(verifyWebhookSignature({ secret: '', payload: body, signature: sign(body) })).toBe(false);
  expect(verifyWebhookSignature({ secret, payload: body, signature: '' })).toBe(false);
});

test('rejects a malformed/short signature without throwing', () => {
  expect(verifyWebhookSignature({ secret, payload: body, signature: 'abc123' })).toBe(false);
});

test('works on raw byte payloads', () => {
  const bytes = new TextEncoder().encode(body);
  const sig = createHmac('sha256', secret).update(bytes).digest('hex');
  expect(verifyWebhookSignature({ secret, payload: bytes, signature: sig })).toBe(true);
});
