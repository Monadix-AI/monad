import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { type DevDoctorDeps, runDevDoctor } from '../../dev-doctor/checks.ts';

const root = '/repo';
const packageJson = JSON.stringify({ packageManager: 'bun@1.3.14' });
const envLocal = 'MONAD_PORT=52147\nWEB_PORT=3247\n';

function deps(files: Record<string, string> = {}, overrides: Partial<DevDoctorDeps> = {}): DevDoctorDeps {
  return {
    bunVersion: '1.3.14',
    exists: async (path) => Object.hasOwn(files, path),
    portPids: () => [],
    readText: async (path) => files[path] ?? '',
    which: () => null,
    ...overrides
  };
}

function healthyFiles(): Record<string, string> {
  return {
    [join(root, 'package.json')]: packageJson,
    [join(root, 'node_modules')]: '',
    [join(root, '.env.local')]: envLocal,
    [join(root, '.dev/bin/monad')]: `#!/bin/sh\nexec bun '${root}/apps/cli/src/bin.ts' "$@"\n`,
    [join(root, 'packages/atoms/generated/codex-app-server')]: '',
    [join(root, 'apps/web/src/routeTree.gen.ts')]: '',
    [join(root, 'apps/monad/generated/licenses.json')]: ''
  };
}

test('missing dependencies point directly to bun install', async () => {
  const files = healthyFiles();
  delete files[join(root, 'node_modules')];

  const results = await runDevDoctor(root, deps(files));

  expect(results.find((result) => result.id === 'dependencies')).toMatchObject({
    repair: 'bun install',
    status: 'error'
  });
});

test('Bun version mismatch reports the pinned version', async () => {
  const results = await runDevDoctor(root, deps(healthyFiles(), { bunVersion: '1.3.15' }));

  expect(results.find((result) => result.id === 'bun-version')).toMatchObject({
    message: 'Bun 1.3.15 is active; this repository pins 1.3.14',
    status: 'error'
  });
});

test('missing environment and stale CLI shim point to setup', async () => {
  const files = healthyFiles();
  delete files[join(root, '.env.local')];
  files[join(root, '.dev/bin/monad')] = "exec bun '/other/apps/cli/src/bin.ts'\n";

  const results = await runDevDoctor(root, deps(files));

  expect(results.filter((result) => ['environment', 'cli-shim'].includes(result.id))).toEqual([
    expect.objectContaining({ id: 'environment', repair: 'bun run setup', status: 'error' }),
    expect.objectContaining({ id: 'cli-shim', repair: 'bun run setup', status: 'error' })
  ]);
});

test('occupied configured ports report PIDs without changing them', async () => {
  const results = await runDevDoctor(
    root,
    deps(healthyFiles(), { portPids: (port) => (port === '52147' ? ['991'] : []) })
  );

  expect(results.find((result) => result.id === 'ports')).toMatchObject({
    message: 'Configured port 52147 is occupied by PID 991',
    status: 'error'
  });
});

test('healthy core setup returns only successful results', async () => {
  const results = await runDevDoctor(root, deps(healthyFiles()));

  expect(results.every((result) => result.status === 'ok')).toBe(true);
});
