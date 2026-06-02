// POSIX environment names are case-sensitive: `PATH` and `path` are two distinct variables, so the
// strip invariant must remove exactly what a policy names and nothing else.

import { expect, test } from 'bun:test';

import { stripEnvKeys } from '#/services/mesh-agent/env.ts';

test('stripEnvKeys removes only the exact-case name on POSIX', () => {
  const env: Record<string, string | undefined> = { PATH: '/usr/bin', path: '/lower/bin', Path: '/mixed/bin' };
  stripEnvKeys(env, new Set(['PATH']));
  expect(env).toEqual({ path: '/lower/bin', Path: '/mixed/bin' });
});

test('stripEnvKeys leaves a differently-cased marker alone on POSIX', () => {
  const env: Record<string, string | undefined> = { Claudecode: '1', KEPT: 'keep-me' };
  stripEnvKeys(env, new Set(['CLAUDECODE']));
  expect(env).toEqual({ Claudecode: '1', KEPT: 'keep-me' });
});
