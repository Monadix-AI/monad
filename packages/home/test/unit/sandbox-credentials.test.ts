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

  test('file entry with extract parses', () => {
    const cfg = sandboxConfigSchema.parse({
      credentials: [{ name: 'NETRC', file: '~/.netrc', injectHosts: ['api.example.com'], extract: 'password (\\S+)' }]
    });
    expect(cfg.credentials[0]).toMatchObject({ name: 'NETRC', file: '~/.netrc', extract: 'password (\\S+)' });
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
