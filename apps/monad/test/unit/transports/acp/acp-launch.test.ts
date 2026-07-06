// Unit test for the auto-spawn argv/env computation. The actual spawn+poll is integration (and
// spawning a 2nd bun trips macOS taskgated), so we test the pure helper — specifically the
// spawn-loop guard: the spawned daemon must inherit neither the ACP flag nor the ACP env.

import { expect, test } from 'bun:test';

import { computeDaemonSpawn } from '@/transports/acp/launch.ts';

test('computeDaemonSpawn strips the --acp/--stdio flags from argv', () => {
  const { argv } = computeDaemonSpawn(['bun', '/path/main.ts', '--acp', '--mock-model'], {});
  expect(argv).toEqual(['bun', '/path/main.ts', '--mock-model']);

  const stdio = computeDaemonSpawn(['monad', 'daemon', '--stdio'], {});
  expect(stdio.argv).toEqual(['monad', 'daemon']);
});

test('computeDaemonSpawn deletes MONAD_ACP and MONAD_STDIO from env (prevents spawn loop)', () => {
  // The CLI launches `monad acp` with MONAD_ACP=true; without stripping it the child re-enters
  // bridge mode and spawns again forever.
  const { env } = computeDaemonSpawn(['bun', 'main.ts', '--acp'], {
    MONAD_ACP: 'true',
    MONAD_STDIO: 'true',
    MONAD_PORT: '52749',
    PATH: '/usr/bin'
  });
  // unrelated env is preserved
  expect(env.MONAD_PORT).toBe('52749');
  expect(env.PATH).toBe('/usr/bin');
});

test('computeDaemonSpawn does not mutate the caller env', () => {
  const original = { MONAD_ACP: 'true' };
  computeDaemonSpawn(['bun', 'main.ts'], original);
  expect(original.MONAD_ACP).toBe('true'); // caller's Bun.env untouched
});
