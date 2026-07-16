import { describe, expect, test } from 'bun:test';

import { sandboxConfigSchema } from '../../src/config/index.ts';

// The credentials[] entry is an env-XOR-file union: exactly one of `value` (env sentinel) or
// `file` (masked file) must be set. Back-compat: the pre-existing {name,value,injectHosts} shape
// still parses unchanged.

describe('sandbox credentials env/file union', () => {
  test('back-compat: {name,value,injectHosts} (env) parses', () => {
    const secretRef = '${' + 'secret:GH}';
    const cfg = sandboxConfigSchema.parse({
      credentials: [{ name: 'GH_TOKEN', value: secretRef, injectHosts: ['api.github.com'] }]
    });
    expect(cfg.credentials[0]).toMatchObject({ name: 'GH_TOKEN', value: secretRef });
  });

  test('legacy file extract normalizes to canonical transform.extract', () => {
    const cfg = sandboxConfigSchema.parse({
      credentials: [{ name: 'NETRC', file: '~/.netrc', injectHosts: ['api.example.com'], extract: 'password (\\S+)' }]
    });
    expect(cfg.credentials[0]).toMatchObject({
      name: 'NETRC',
      file: '~/.netrc',
      transform: { extract: 'password (\\S+)' }
    });
    expect('extract' in (cfg.credentials[0] ?? {})).toBe(false);
  });

  test('canonical structured transform parses', () => {
    const secretRef = '${' + 'secret:TOKEN}';
    const cfg = sandboxConfigSchema.parse({
      credentials: [
        {
          name: 'TOKEN',
          value: secretRef,
          injectHosts: ['api.example.com'],
          transform: { extract: 'token=([^;]+)', maskDuplicates: true, decode: 'jwt', maskClaims: ['sub', 'email'] }
        }
      ]
    });
    expect(cfg.credentials[0]?.transform).toEqual({
      extract: 'token=([^;]+)',
      maskDuplicates: true,
      decode: 'jwt',
      maskClaims: ['sub', 'email']
    });
  });

  test.each([
    { transform: { maskDuplicates: true } },
    { transform: { maskClaims: ['sub'] } },
    { transform: { decode: 'jwt', maskClaims: ['sub', 'sub'] } },
    { transform: { decode: 'jwt', maskClaims: [''] } }
  ])('invalid transform dependencies are rejected: %j', ({ transform }) => {
    expect(() =>
      sandboxConfigSchema.parse({
        credentials: [{ name: 'X', value: 'v', injectHosts: ['h'], transform }]
      })
    ).toThrow();
  });

  test('setting neither value nor file is rejected', () => {
    expect(() => sandboxConfigSchema.parse({ credentials: [{ name: 'X', injectHosts: ['h'] }] })).toThrow();
  });

  test('setting both value and file is rejected', () => {
    expect(() =>
      sandboxConfigSchema.parse({
        credentials: [{ name: 'X', value: 'v', file: '/f', injectHosts: ['h'] }]
      })
    ).toThrow();
  });
});

test('VM baselines are bounded and disabled by default', () => {
  const configured = sandboxConfigSchema.parse({
    vm: { baseline: { enabled: true, maxInactiveArtifacts: 2, maxBytes: 4096 } }
  });
  expect(configured.vm?.baseline).toEqual({ enabled: true, maxInactiveArtifacts: 2, maxBytes: 4096 });
  expect(sandboxConfigSchema.parse({ vm: {} }).vm?.baseline.enabled).toBe(false);
});
