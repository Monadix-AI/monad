// Attack-pattern tests for the egress allowlist decision (egress-policy.ts). Modeled on real
// sandbox-runtime disclosures rather than exhaustive unit coverage:
//   - GHSA-9gqj-5w7c-vx47 / CVE-2025-66479: an EMPTY allowedDomains list disabled enforcement
//     instead of denying everything ("fail open on misconfiguration").
//   - domain-suffix confusion: an attacker-registered domain that merely CONTAINS an allowed domain
//     as a substring/suffix-of-label must not be treated as a subdomain of it.

import { describe, expect, test } from 'bun:test';

import { domainMatches, isEgressAllowed, normalizeHost } from '../../src/egress-policy.ts';

describe('CVE-2025-66479 pattern: empty/misconfigured allowlist must deny, never fail open', () => {
  test('allowedDomains: [] denies every host — the empty list is NOT "no restriction"', () => {
    expect(isEgressAllowed('example.com', { allowedDomains: [] })).toBe(false);
    expect(isEgressAllowed('anything.at.all', { allowedDomains: [] })).toBe(false);
    expect(isEgressAllowed('169.254.169.254', { allowedDomains: [] })).toBe(false);
  });

  test('allowedDomains: [""] (a stray empty-string entry) does not accidentally allow-all', () => {
    expect(isEgressAllowed('example.com', { allowedDomains: [''] })).toBe(false);
  });

  test('only the literal "*" wildcard opens broad egress — no other value is treated as a wildcard', () => {
    expect(isEgressAllowed('example.com', { allowedDomains: ['**'] })).toBe(false);
    expect(isEgressAllowed('example.com', { allowedDomains: ['.'] })).toBe(false);
  });
});

describe('domain-suffix confusion: attacker-chosen domains that merely resemble an allowed one', () => {
  const policy = { allowedDomains: ['example.com'] };

  test('a domain containing the allowed domain as a substring (no dot boundary) is NOT matched', () => {
    expect(isEgressAllowed('evil-example.com', policy)).toBe(false);
    expect(isEgressAllowed('notexample.com', policy)).toBe(false);
    expect(isEgressAllowed('example.com.evil.com', policy)).toBe(false);
  });

  test('a proper subdomain IS matched (the intended, safe case)', () => {
    expect(isEgressAllowed('api.example.com', policy)).toBe(true);
    expect(isEgressAllowed('example.com', policy)).toBe(true);
  });

  test('domainMatches enforces a dot boundary, not a bare string suffix', () => {
    expect(domainMatches('evilexample.com', 'example.com')).toBe(false);
    expect(domainMatches('sub.example.com', 'example.com')).toBe(true);
  });
});

describe('deniedDomains carve-out wins even under the "*" wildcard', () => {
  test('an explicit deny beats a broad allow — the allowlist can widen but never re-open a denied host', () => {
    const policy = { allowedDomains: ['*'], deniedDomains: ['internal.corp'] };
    expect(isEgressAllowed('public.example.com', policy)).toBe(true);
    expect(isEgressAllowed('internal.corp', policy)).toBe(false);
    expect(isEgressAllowed('vpn.internal.corp', policy)).toBe(false);
  });
});

describe('SSRF: loopback/link-local/cloud-metadata is denied even under "*"', () => {
  const policy = { allowedDomains: ['*'] };

  test('bare IP literals to private/loopback/metadata ranges are denied regardless of the allowlist', () => {
    expect(isEgressAllowed('127.0.0.1', policy)).toBe(false);
    expect(isEgressAllowed('169.254.169.254', policy)).toBe(false);
    expect(isEgressAllowed('10.0.0.5', policy)).toBe(false);
    expect(isEgressAllowed('192.168.1.1', policy)).toBe(false);
  });

  test('localhost and *.localhost / *.local are denied regardless of the allowlist', () => {
    expect(isEgressAllowed('localhost', policy)).toBe(false);
    expect(isEgressAllowed('foo.localhost', policy)).toBe(false);
    expect(isEgressAllowed('printer.local', policy)).toBe(false);
  });
});

describe('normalizeHost: matcher cannot be dodged via bracket/case/trailing-dot tricks', () => {
  test('IPv6 brackets and a trailing FQDN root dot are stripped before comparison', () => {
    expect(normalizeHost('[::1]')).toBe('::1');
    expect(normalizeHost('example.com.')).toBe('example.com');
  });

  test('mixed-case host still matches a lowercase allow/deny entry', () => {
    expect(domainMatches('API.Example.COM', 'example.com')).toBe(true);
  });

  test('a trailing dot on the queried host does not evade a deny rule (FQDN-root smuggling)', () => {
    const policy = { allowedDomains: ['*'], deniedDomains: ['internal.corp'] };
    expect(isEgressAllowed('internal.corp.', policy)).toBe(false);
  });
});
