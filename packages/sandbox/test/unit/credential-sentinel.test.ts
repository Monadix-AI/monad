import { describe, expect, test } from 'bun:test';

import { SENTINEL_PREFIX, SentinelRegistry } from '../../src/credential-sentinel.ts';

describe('SentinelRegistry', () => {
  test('register mints a unique fake_value_… sentinel and childEnv maps name→sentinel', () => {
    const reg = new SentinelRegistry();
    const s1 = reg.register('TOKEN', 'supersecret', ['allowed.com']);
    const s2 = reg.register('OTHER', 'othersecret', ['other.com']);
    expect(s1.startsWith(SENTINEL_PREFIX)).toBe(true);
    expect(s2.startsWith(SENTINEL_PREFIX)).toBe(true);
    expect(s1).not.toBe(s2);
    expect(reg.childEnv()).toEqual({ TOKEN: s1, OTHER: s2 });
  });

  test('substitute swaps sentinel→real for a matching injectHost', () => {
    const reg = new SentinelRegistry();
    const sentinel = reg.register('TOKEN', 'supersecret', ['allowed.com']);
    const header = `Authorization: Bearer ${sentinel}`;
    expect(reg.substitute('api.allowed.com', header)).toBe('Authorization: Bearer supersecret');
    // subdomain match: api.allowed.com matches injectHost allowed.com
    expect(reg.substitute('allowed.com', header)).toBe('Authorization: Bearer supersecret');
  });

  test('substitute LEAVES the sentinel when the host is not in injectHosts', () => {
    const reg = new SentinelRegistry();
    const sentinel = reg.register('TOKEN', 'supersecret', ['allowed.com']);
    const header = `Authorization: Bearer ${sentinel}`;
    const out = reg.substitute('evil.com', header);
    expect(out).toBe(header);
    expect(out).not.toContain('supersecret');
  });

  test('multiple credentials do not cross-substitute: A on B-only host stays sentinel', () => {
    const reg = new SentinelRegistry();
    const a = reg.register('A', 'secretA', ['a.com']);
    const b = reg.register('B', 'secretB', ['b.com']);
    // On b.com, only B's sentinel is swapped; A's sentinel is left intact.
    const header = `X-A: ${a}\r\nX-B: ${b}`;
    const out = reg.substitute('b.com', header);
    expect(out).toContain('secretB');
    expect(out).not.toContain('secretA');
    expect(out).toContain(a);
  });

  test('empty registry is a no-op', () => {
    const reg = new SentinelRegistry();
    expect(reg.substitute('any.com', 'Authorization: Bearer fake_value_x')).toBe('Authorization: Bearer fake_value_x');
    expect(reg.size).toBe(0);
  });

  test('registerMaterialized restores every explicit mapping and publishes the structured child value', () => {
    const reg = new SentinelRegistry();
    reg.registerMaterialized('TOKEN', 'prefix.fake-jwt.signature', [
      { fake: 'fake-jwt', real: 'real-jwt', injectHosts: ['allowed.com'] },
      { fake: 'fake-claim', real: 'real-claim', injectHosts: ['claims.example'] }
    ]);
    expect(reg.childEnv()).toEqual({ TOKEN: 'prefix.fake-jwt.signature' });
    expect(reg.substitute('api.allowed.com', 'Bearer fake-jwt')).toBe('Bearer real-jwt');
    expect(reg.substitute('evil.com', 'Bearer fake-jwt')).toBe('Bearer fake-jwt');
    expect(reg.substitute('claims.example', 'fake-claim')).toBe('real-claim');
  });

  test.each(['allowed.com.', 'api.allowed.com.'])('normalizes a trailing dot on destination %s', (host) => {
    const reg = new SentinelRegistry();
    const fake = reg.register('TOKEN', 'real', ['allowed.com']);
    expect(reg.substitute(host, fake)).toBe('real');
  });

  test.each(['siblingallowed.com', '127.0.0.1', 'xn--allowed-9za.com'])('does not broaden host scope to %s', (host) => {
    const reg = new SentinelRegistry();
    const fake = reg.register('TOKEN', 'real', ['allowed.com']);
    expect(reg.substitute(host, fake)).toBe(fake);
  });
});

test('register strips CR/LF from the real value (no header injection on substitution)', () => {
  const reg = new SentinelRegistry();
  const s = reg.register('T', 'good\r\nX-Evil: 1', ['h.com']);
  const out = reg.substitute('h.com', `Authorization: Bearer ${s}`);
  expect(out).toBe('Authorization: Bearer goodX-Evil: 1');
  expect(out).not.toContain('\r');
  expect(out).not.toContain('\n');
});
