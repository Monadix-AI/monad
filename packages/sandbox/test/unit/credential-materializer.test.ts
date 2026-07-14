import { describe, expect, test } from 'bun:test';

import { CredentialMaterializationError, materializeCredential } from '../../src/credential-materializer.ts';
import { SENTINEL_PREFIX } from '../../src/credential-sentinel.ts';

const hosts = ['api.example.com'];

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.original-signature`;
}

describe('credential materializer', () => {
  test('whole values become a single opaque substitution', () => {
    const result = materializeCredential('secret', hosts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.childValue.startsWith(SENTINEL_PREFIX)).toBe(true);
    expect(result.value.childValue).not.toContain('secret');
    expect(result.value.substitutions).toEqual([{ fake: result.value.childValue, real: 'secret', injectHosts: hosts }]);
  });

  test('extract masks multiple captures and reuses a mapping for duplicate captures', () => {
    const result = materializeCredential('a=one;b=two;c=one', hosts, { extract: '[abc]=([^;]+)' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.substitutions).toHaveLength(2);
    const [one, two] = result.value.substitutions;
    expect(result.value.childValue).toBe(`a=${one?.fake};b=${two?.fake};c=${one?.fake}`);
  });

  test('maskDuplicates masks captured values outside capture spans', () => {
    const result = materializeCredential('token=abc;mirror=abc', hosts, {
      extract: 'token=([^;]+)',
      maskDuplicates: true
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fake = result.value.substitutions[0]?.fake;
    expect(result.value.childValue).toBe(`token=${fake};mirror=${fake}`);
  });

  test.each([
    ['(', CredentialMaterializationError.INVALID_REGEX],
    ['nope=(.+)', CredentialMaterializationError.NO_MATCH],
    ['x=(a)?', CredentialMaterializationError.EMPTY_CAPTURE]
  ] as const)('returns a fixed error for invalid extraction %s', (extract, error) => {
    const result = materializeCredential('x=', hosts, { extract });
    expect(result).toEqual({ ok: false, error });
  });

  test('bounds input without putting input bytes in the error', () => {
    const result = materializeCredential('x'.repeat(1024 * 1024 + 1), hosts);
    expect(result).toEqual({ ok: false, error: CredentialMaterializationError.INPUT_TOO_LARGE });
  });

  test('catastrophic extraction is terminated by the regex deadline', () => {
    const result = materializeCredential(`${'a'.repeat(200_000)}!`, hosts, { extract: '^(a+)+$' });
    expect(result).toEqual({ ok: false, error: CredentialMaterializationError.REGEX_TIMEOUT });
  });

  test('JWT decoding creates a parseable non-secret fake and restores the whole token', () => {
    const original = jwt({ sub: 'real-user', email: 'real@example.com', admin: true });
    const result = materializeCredential(original, hosts, { decode: 'jwt' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parts = result.value.childValue.split('.');
    expect(parts).toHaveLength(3);
    expect(JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'))).toHaveProperty('monad');
    expect(result.value.childValue).not.toContain('real-user');
    expect(result.value.substitutions).toEqual([{ fake: result.value.childValue, real: original, injectHosts: hosts }]);
  });

  test('JWT claim masking preserves unrelated claim types and masks requested strings', () => {
    const original = jwt({ sub: 'real-user', admin: true, count: 3 });
    const result = materializeCredential(original, hosts, { decode: 'jwt', maskClaims: ['sub'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = JSON.parse(
      Buffer.from(result.value.childValue.split('.')[1] ?? '', 'base64url').toString('utf8')
    ) as Record<string, unknown>;
    expect(String(payload.sub).startsWith(SENTINEL_PREFIX)).toBe(true);
    expect(payload.admin).toBe(true);
    expect(payload.count).toBe(3);
    expect(result.value.substitutions[0]?.real).toBe(original);
  });

  test.each([
    ['not-a-jwt', undefined, CredentialMaterializationError.INVALID_JWT],
    [jwt({ admin: true }), ['sub'], CredentialMaterializationError.MISSING_JWT_CLAIM],
    [jwt({ sub: 42 }), ['sub'], CredentialMaterializationError.INVALID_JWT_CLAIM]
  ] as const)('rejects invalid JWT materialization', (input, maskClaims, error) => {
    expect(materializeCredential(input, hosts, { decode: 'jwt', maskClaims })).toEqual({ ok: false, error });
  });
});
