import { expect, test } from 'bun:test';

import { resolveAllowedOrigin, tokenMatches } from '@/transports/http.ts';

// ── resolveAllowedOrigin ───────────────────────────────────────────────────────

const req = (headers: Record<string, string>) => new Request('http://127.0.0.1:52749/v1/sessions', { headers });

test('resolveAllowedOrigin: allows loopback origins', () => {
  expect(resolveAllowedOrigin(req({ origin: 'http://127.0.0.1:52749' }))).toBe('http://127.0.0.1:52749');
  expect(resolveAllowedOrigin(req({ origin: 'http://localhost:52749' }))).toBe('http://localhost:52749');
  expect(resolveAllowedOrigin(req({ origin: 'http://[::1]:52749' }))).toBe('http://[::1]:52749');
});

test('resolveAllowedOrigin: allows same-host as the listener (web UI behind reverse proxy)', () => {
  expect(
    resolveAllowedOrigin(req({ host: 'dashboard.example.com:52749', origin: 'https://dashboard.example.com' }))
  ).toBe('https://dashboard.example.com');
});

test('resolveAllowedOrigin: rejects cross-site origins — does not reflect them', () => {
  expect(resolveAllowedOrigin(req({ host: '127.0.0.1:52749', origin: 'https://evil.com' }))).toBeNull();
  expect(resolveAllowedOrigin(req({ host: '127.0.0.1:52749', origin: 'http://attacker.local' }))).toBeNull();
});

test('resolveAllowedOrigin: returns null when no Origin header', () => {
  expect(resolveAllowedOrigin(req({ host: '127.0.0.1:52749' }))).toBeNull();
});

test('resolveAllowedOrigin: returns null for a malformed Origin', () => {
  expect(resolveAllowedOrigin(req({ origin: 'not-a-url' }))).toBeNull();
});

// ── tokenMatches ──────────────────────────────────────────────────────────────

test('tokenMatches: identical strings match', () => {
  expect(tokenMatches('Bearer secret123', 'Bearer secret123')).toBe(true);
});

test('tokenMatches: different strings do not match', () => {
  expect(tokenMatches('Bearer wrong', 'Bearer secret123')).toBe(false);
  expect(tokenMatches('', 'Bearer secret123')).toBe(false);
  expect(tokenMatches('Bearer secret123', '')).toBe(false);
});

test('tokenMatches: different-length strings do not match (no short-circuit)', () => {
  // Also verifies it does not throw on length mismatch (timingSafeEqual requirement)
  expect(tokenMatches('Bearer short', 'Bearer much-longer-secret')).toBe(false);
  expect(tokenMatches('Bearer much-longer-secret', 'Bearer short')).toBe(false);
});

test('tokenMatches: empty vs empty', () => {
  expect(tokenMatches('', '')).toBe(true);
});
