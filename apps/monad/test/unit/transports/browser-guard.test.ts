import { expect, test } from 'bun:test';

import { isBrowserRequestAllowed, isLoopbackPeer } from '@/transports/http/browser-guard.ts';

const req = (headers: Record<string, string>) => new Request('http://127.0.0.1:52749/v1/sessions', { headers });

const local = { remoteEnabled: false };
const remote = { remoteEnabled: true };

// ── loopback peer gate (host-desktop endpoints, e.g. /v1/system/pick-directory) ─

test('isLoopbackPeer: Unix socket (no address) and loopback addresses are local', () => {
  expect(isLoopbackPeer(undefined)).toBe(true);
  expect(isLoopbackPeer(null)).toBe(true);
  expect(isLoopbackPeer('127.0.0.1')).toBe(true);
  expect(isLoopbackPeer('::1')).toBe(true);
  expect(isLoopbackPeer('::ffff:127.0.0.1')).toBe(true);
});

test('isLoopbackPeer: a remote peer is rejected even though the token guard would admit it', () => {
  expect(isLoopbackPeer('192.168.1.20')).toBe(false);
  expect(isLoopbackPeer('10.0.0.5')).toBe(false);
});

// ── loopback-only daemon (default) ──────────────────────────────────────────────

test('allows native clients (no Origin) on a loopback Host', () => {
  expect(isBrowserRequestAllowed(req({ host: '127.0.0.1:52749' }), local)).toBe(true);
  expect(isBrowserRequestAllowed(req({ host: 'localhost:52749' }), local)).toBe(true);
  expect(isBrowserRequestAllowed(req({ host: '[::1]:52749' }), local)).toBe(true);
});

test('allows same-origin browser requests from loopback', () => {
  expect(isBrowserRequestAllowed(req({ host: '127.0.0.1:52749', origin: 'http://127.0.0.1:52749' }), local)).toBe(true);
  expect(isBrowserRequestAllowed(req({ host: 'localhost:52749', origin: 'http://localhost:52749' }), local)).toBe(true);
});

test('rejects cross-site browser origins (CSRF/CSWSH)', () => {
  expect(isBrowserRequestAllowed(req({ host: '127.0.0.1:52749', origin: 'https://evil.com' }), local)).toBe(false);
  expect(isBrowserRequestAllowed(req({ host: '127.0.0.1:52749', origin: 'http://attacker.local:8080' }), local)).toBe(
    false
  );
});

test('rejects non-loopback Host (DNS rebinding) even with no/again-matching Origin', () => {
  // Rebound page: its domain now resolves to 127.0.0.1; request looks same-origin.
  expect(isBrowserRequestAllowed(req({ host: 'attacker.com:52749', origin: 'http://attacker.com:52749' }), local)).toBe(
    false
  );
  expect(isBrowserRequestAllowed(req({ host: 'attacker.com:52749' }), local)).toBe(false);
});

test('rejects a malformed Origin', () => {
  expect(isBrowserRequestAllowed(req({ host: '127.0.0.1:52749', origin: 'not-a-url' }), local)).toBe(false);
});

// ── remote access enabled (bearer-token gated, bound to a real host) ─────────────

test('remote: allows same-origin as the served listener', () => {
  expect(
    isBrowserRequestAllowed(req({ host: '192.168.1.20:52749', origin: 'http://192.168.1.20:52749' }), remote)
  ).toBe(true);
});

test('remote: allows loopback and native clients', () => {
  expect(isBrowserRequestAllowed(req({ host: '192.168.1.20:52749' }), remote)).toBe(true);
  expect(isBrowserRequestAllowed(req({ host: '192.168.1.20:52749', origin: 'http://localhost:3000' }), remote)).toBe(
    true
  );
});

test('remote: rejects a cross-site origin', () => {
  expect(isBrowserRequestAllowed(req({ host: '192.168.1.20:52749', origin: 'https://evil.com' }), remote)).toBe(false);
});
