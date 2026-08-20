import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { type DevDoctorDeps, runDevDoctor } from '../../dev-doctor/checks.ts';
import { devCliShimText } from '../../dev-init/cli-shim.ts';

const root = '/repo';
const packageJson = JSON.stringify({ packageManager: 'bun@1.3.14' });
const envLocal = 'MONAD_PORT=52147\nWEB_PORT=3247\n';

function deps(files: Record<string, string> = {}, overrides: Partial<DevDoctorDeps> = {}): DevDoctorDeps {
  return {
    bunVersion: '1.3.14',
    exists: async (path) => Object.hasOwn(files, path),
    isPortAvailable: async () => true,
    platform: 'linux',
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
    [join(root, '.dev/bin/monad')]: devCliShimText('darwin'),
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
  // A shim written before the shim format became self-locating.
  files[join(root, '.dev/bin/monad')] = `#!/bin/sh\nexec bun '/other/apps/cli/src/bin.ts' "$@"\n`;

  const results = await runDevDoctor(root, deps(files));

  expect(results.filter((result) => ['environment', 'cli-shim'].includes(result.id))).toEqual([
    expect.objectContaining({ id: 'environment', repair: 'mise run setup', status: 'error' }),
    expect.objectContaining({ id: 'cli-shim', repair: 'mise run setup', status: 'error' })
  ]);
});

test('occupied configured ports report PIDs without changing them', async () => {
  const results = await runDevDoctor(
    root,
    deps(healthyFiles(), {
      isPortAvailable: async (port) => port !== 52147,
      portPids: (port) => (port === '52147' ? ['991'] : [])
    })
  );

  expect(results.find((result) => result.id === 'ports')).toMatchObject({
    message: 'MONAD_PORT port 52147 is occupied by PID 991',
    repair: 'mise run dev:ports -- --rotate',
    status: 'error'
  });
});

test('occupied configured ports are detected when process IDs are unavailable', async () => {
  const results = await runDevDoctor(root, deps(healthyFiles(), { isPortAvailable: async (port) => port !== 3247 }));

  expect(results.find((result) => result.id === 'ports')).toEqual({
    id: 'ports',
    message: 'WEB_PORT port 3247 is occupied',
    repair: 'mise run dev:ports -- --rotate',
    status: 'error'
  });
});

test('healthy core setup returns only successful results', async () => {
  const results = await runDevDoctor(root, deps(healthyFiles()));

  expect(results.every((result) => result.status === 'ok')).toBe(true);
});
