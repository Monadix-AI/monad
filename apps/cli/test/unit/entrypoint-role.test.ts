import { expect, test } from 'bun:test';

import { resolveEntrypointSubcommand } from '../../src/lib/entrypoint-role.ts';

test('explicit subcommand wins over release process-name aliases', () => {
  expect(
    resolveEntrypointSubcommand(['/opt/monad/bin/monad-daemon', 'bin.ts', '--help'], '/opt/monad/bin/monad-daemon')
  ).toBe('--help');
});

test('release daemon alias resolves to the daemon subcommand', () => {
  expect(resolveEntrypointSubcommand(['/opt/monad/bin/monad-daemon', 'bin.ts'], '/opt/monad/bin/monad-daemon')).toBe(
    'daemon'
  );
});

test('release restart alias resolves to the supervisor subcommand', () => {
  expect(resolveEntrypointSubcommand(['/opt/monad/bin/monad-restart', 'bin.ts'], '/opt/monad/bin/monad-restart')).toBe(
    'daemon-supervisor'
  );
});

test('plain monad keeps the default up entrypoint', () => {
  expect(resolveEntrypointSubcommand(['/opt/monad/bin/monad', 'bin.ts'], '/opt/monad/bin/monad')).toBeUndefined();
});
