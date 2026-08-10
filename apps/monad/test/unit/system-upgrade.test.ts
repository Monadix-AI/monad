import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MONAD_VERSION } from '@monad/protocol';

import { createSystemUpgradeModule, workerCommand } from '#/handlers/system-upgrade.ts';

type SpawnOptions = NonNullable<Parameters<typeof Bun.spawn>[1]>;

function releaseFetch(tag = 'v9.9.9'): typeof fetch {
  return (async () => new Response(JSON.stringify({ tag_name: tag }))) as unknown as typeof fetch;
}

async function waitForStage(upgrade: ReturnType<typeof createSystemUpgradeModule>, stage: string): Promise<void> {
  for (let index = 0; index < 30; index += 1) {
    if (upgrade.getStatus().stage === stage) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${stage}; got ${upgrade.getStatus().stage}`);
}

async function writeAttempt(cacheDir: string, targetVersion: string, exitCode: number): Promise<void> {
  await writeFile(
    join(cacheDir, 'attempt.json'),
    JSON.stringify({
      targetVersion,
      tag: `v${targetVersion}`,
      startedAt: '2026-08-10T00:00:00.000Z',
      completedAt: null,
      exitCode: null,
      logPath: join(cacheDir, 'updater.log'),
      state: 'installing'
    })
  );
  await writeFile(join(cacheDir, 'result.txt'), `${exitCode}\n2026-08-10T00:00:05Z\n`);
}

test.each([
  ['newer', '9.9.9', true],
  ['older', '0.0.0', false]
] as const)('system upgrade reflects cached stable release: %s', (_case, latestVersion, available) => {
  const upgrade = createSystemUpgradeModule({
    getUpgradeInfo: () => ({ latestVersion, latestVersionCheckedAt: '2026-08-10T00:00:00.000Z' })
  });

  expect(upgrade.getStatus()).toMatchObject({ available, currentVersion: MONAD_VERSION, latestVersion, stage: 'idle' });
});

test('system upgrade resolves the exact release and verifies monad-update exists', async () => {
  const checked: string[] = [];
  const upgrade = createSystemUpgradeModule({
    access: async (path) => {
      checked.push(path);
    },
    binaryPath: '/opt/monad/bin/monad',
    cacheDir: '/unused-trigger',
    fetch: releaseFetch()
  });

  upgrade.getStatus();
  await waitForStage(upgrade, 'ready');

  expect(checked).toEqual(['/opt/monad/bin/monad-update']);
  expect(upgrade.getStatus()).toMatchObject({ available: true, latestVersion: '9.9.9', progress: 100 });
});

test('system upgrade reports a reinstall requirement when monad-update is missing', async () => {
  const upgrade = createSystemUpgradeModule({
    access: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    cacheDir: '/unused-trigger',
    fetch: releaseFetch(),
    updaterPath: '/opt/monad/bin/monad-update'
  });

  upgrade.getStatus();
  await waitForStage(upgrade, 'failed');
  expect(upgrade.getStatus().error).toContain('reinstall Monad');
});

test('system upgrade detaches a worker, returns restarting, then schedules daemon exit', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'monad-system-upgrade-'));
  let argv: string[] | undefined;
  let spawnOptions: SpawnOptions | undefined;
  let unrefCalled = false;
  let exitScheduled = false;
  const upgrade = createSystemUpgradeModule({
    access: async () => {},
    binaryPath: '/opt/monad/bin/monad',
    cacheDir,
    fetch: releaseFetch(),
    parentPid: 1234,
    platform: 'linux',
    scheduleExit: () => {
      exitScheduled = true;
    },
    spawn: ((args: string[], options?: SpawnOptions) => {
      argv = args;
      spawnOptions = options;
      return {
        exited: Promise.resolve(0),
        unref: () => {
          unrefCalled = true;
        }
      };
    }) as typeof Bun.spawn
  });

  upgrade.getStatus();
  await waitForStage(upgrade, 'ready');
  await upgrade.start();

  expect(argv?.slice(0, 2)).toEqual(['sh', '-c']);
  expect(argv?.[2]).toContain('"$2" --tag "$3" >"$6" 2>&1');
  expect(argv?.[2]).toContain('printf "%s\\n%s\\n" "$update_code" "$completed" >"$5.tmp"');
  expect(argv?.[2]).toContain('"$4" restart >>"$6" 2>&1');
  expect(argv?.slice(3)).toEqual([
    'monad-upgrade',
    '1234',
    '/opt/monad/bin/monad-update',
    'v9.9.9',
    '/opt/monad/bin/monad',
    join(cacheDir, 'result.txt'),
    join(cacheDir, 'updater.log')
  ]);
  expect(spawnOptions).toMatchObject({ detached: true, stderr: 'ignore', stdin: 'ignore', stdout: 'ignore' });
  expect(unrefCalled).toBe(true);
  expect(exitScheduled).toBe(true);
  expect(upgrade.getStatus().stage).toBe('restarting');
  expect(upgrade.getStatus().lastAttempt).toMatchObject({ state: 'installing', targetVersion: '9.9.9' });
  await rm(cacheDir, { force: true, recursive: true });
});

test('Windows worker waits for the daemon before updating and restarting', () => {
  const command = workerCommand('win32', 42, 'C:\\Monad\\monad-update.exe', 'v2.0.0', 'C:\\Monad\\monad.exe');

  expect(command.slice(0, 6)).toEqual([
    'powershell',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    expect.stringContaining('Wait-Process')
  ]);
  expect(command.slice(-6)).toEqual([
    '42',
    'C:\\Monad\\monad-update.exe',
    'v2.0.0',
    'C:\\Monad\\monad.exe',
    'NUL',
    'NUL'
  ]);
});

test('system upgrade restores a durable failed updater result after daemon restart', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'monad-system-upgrade-result-'));
  await writeAttempt(cacheDir, '9.9.9', 42);

  const upgrade = createSystemUpgradeModule({ cacheDir });
  expect(upgrade.getStatus()).toMatchObject({
    stage: 'failed',
    error: expect.stringContaining('exit code 42'),
    lastAttempt: { completedAt: '2026-08-10T00:00:05Z', exitCode: 42, state: 'failed' }
  });
  await rm(cacheDir, { force: true, recursive: true });
});

test('a durable successful attempt does not block checking the next release', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'monad-system-upgrade-complete-'));
  await writeAttempt(cacheDir, MONAD_VERSION, 0);

  const upgrade = createSystemUpgradeModule({ access: async () => {}, cacheDir, fetch: releaseFetch() });
  expect(upgrade.getStatus()).toMatchObject({ lastAttempt: { state: 'complete' }, stage: 'checking' });
  await waitForStage(upgrade, 'ready');
  await rm(cacheDir, { force: true, recursive: true });
});
