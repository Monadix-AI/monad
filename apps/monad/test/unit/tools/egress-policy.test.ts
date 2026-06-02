import { expect, test } from 'bun:test';

import { domainMatches, type EgressPolicy, isEgressAllowed, normalizeHost } from '#/capabilities/tools';

test('normalizeHost lowercases and strips brackets / trailing dot', () => {
  expect(normalizeHost('Example.COM.')).toBe('example.com');
  expect(normalizeHost('[::1]')).toBe('::1');
});

test('domainMatches: exact and subdomain, not a suffix trick', () => {
  expect(domainMatches('pythonhosted.org', 'pythonhosted.org')).toBe(true);
  expect(domainMatches('files.pythonhosted.org', 'pythonhosted.org')).toBe(true);
  expect(domainMatches('notpythonhosted.org', 'pythonhosted.org')).toBe(false); // suffix, not subdomain
  expect(domainMatches('evil.com', 'pythonhosted.org')).toBe(false);
});

const allow = (allowedDomains: string[]): EgressPolicy => ({ allowedDomains });

test('allows listed domains and their subdomains', () => {
  const p = allow(['pypi.org', 'pythonhosted.org']);
  expect(isEgressAllowed('pypi.org', p)).toBe(true);
  expect(isEgressAllowed('files.pythonhosted.org', p)).toBe(true);
  expect(isEgressAllowed('registry.npmjs.org', p)).toBe(false);
});

test('empty allowlist denies everything', () => {
  expect(isEgressAllowed('pypi.org', allow([]))).toBe(false);
});

test("'*' allows any public host", () => {
  expect(isEgressAllowed('whatever.example', allow(['*']))).toBe(true);
});

test('SSRF/loopback denials are absolute — even under *', () => {
  const star = allow(['*']);
  expect(isEgressAllowed('localhost', star)).toBe(false);
  expect(isEgressAllowed('127.0.0.1', star)).toBe(false);
  expect(isEgressAllowed('10.0.0.5', star)).toBe(false);
  expect(isEgressAllowed('169.254.169.254', star)).toBe(false); // cloud metadata
  expect(isEgressAllowed('::1', star)).toBe(false);
  expect(isEgressAllowed('svc.local', star)).toBe(false);
});

test('a private IP literal is denied even if someone lists it', () => {
  expect(isEgressAllowed('192.168.1.10', allow(['192.168.1.10']))).toBe(false);
});

test('deniedDomains win over the allowlist — including over *', () => {
  // Broad allow, one carved-out deny (with subdomains).
  const p: EgressPolicy = { allowedDomains: ['*'], deniedDomains: ['evil.com'] };
  expect(isEgressAllowed('good.example', p)).toBe(true);
  expect(isEgressAllowed('evil.com', p)).toBe(false);
  expect(isEgressAllowed('api.evil.com', p)).toBe(false); // subdomain denied too
  // A deny beats an explicit allow of the same host.
  const q: EgressPolicy = { allowedDomains: ['pypi.org'], deniedDomains: ['pypi.org'] };
  expect(isEgressAllowed('pypi.org', q)).toBe(false);
});
