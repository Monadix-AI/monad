// Windows resolves environment names case-insensitively, so a child's `getenv("CLAUDECODE")` finds a
// value stored as `Claudecode`. The strip invariant must fold case or the marker survives.

import { expect, test } from 'bun:test';

import { stripEnvKeys } from '#/services/mesh-agent/env.ts';

test('stripEnvKeys removes every casing of a stripped name on Windows', () => {
  const env: Record<string, string | undefined> = {
    Claudecode: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    claude_code_entrypoint: 'cli',
    KEPT: 'keep-me'
  };
  stripEnvKeys(env, new Set(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']));
  expect(env).toEqual({ KEPT: 'keep-me' });
});

test('stripEnvKeys matches a lowercase policy key against an uppercase env name on Windows', () => {
  const env: Record<string, string | undefined> = { ADAPTER_KEY: 'x', KEPT: 'keep-me' };
  stripEnvKeys(env, new Set(['adapter_key']));
  expect(env).toEqual({ KEPT: 'keep-me' });
});
