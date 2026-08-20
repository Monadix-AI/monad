import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MONAD_VERSION } from '@monad/protocol';

import { createSystemUpgradeModule, workerCommand, workerLauncherCommand } from '#/handlers/system-upgrade.ts';

type SpawnOptions = NonNullable<Parameters<typeof Bun.spawn>[1]>;

function releaseFetch(tag = 'v9.9.9', corruptAsset?: string): typeof fetch {
  const files = new Map([
    ['monad-x86_64-unknown-linux-gnu.tar.gz', new TextEncoder().encode('archive')],
    ['install.sh', new TextEncoder().encode('#!/bin/sh')]
  ]);
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const asset = [...files].find(([name]) => url.endsWith(`/${name}`));
    if (asset) {
      const bytes = asset[0] === corruptAsset ? new TextEncoder().encode('arcHive') : asset[1];
      return new Response(bytes);
    }
    return new Response(
      JSON.stringify({
        tag_name: tag,
        immutable: true,
        assets: [...files].map(([name, bytes]) => ({
          name,
          browser_download_url: `https://downloads.example/${name}`,
          size: bytes.byteLength,
          digest: `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`
        }))
      })
    );
  }) as unknown as typeof fetch;
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

test('system upgrade downloads and verifies immutable GitHub release assets', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'monad-system-upgrade-prepare-'));
  const upgrade = createSystemUpgradeModule({
    binaryPath: '/opt/monad/bin/monad',
    cacheDir,
    distTarget: 'x86_64-unknown-linux-gnu',
    fetch: releaseFetch(),
    platform: 'linux',
    scheduleExit: () => {},
    spawn: (() => ({ exited: Promise.resolve(0) })) as unknown as typeof Bun.spawn
  });

  upgrade.getStatus();
  await waitForStage(upgrade, 'ready');
  await upgrade.start();

  expect(upgrade.getStatus()).toMatchObject({
    available: true,
    latestVersion: '9.9.9',
    progress: 98,
    stage: 'restarting',
    downloadedBytes: 16,
    totalBytes: 16
  });
  await rm(cacheDir, { force: true, recursive: true });
});

test('system upgrade fails closed when GitHub does not provide immutable asset digests', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'monad-system-upgrade-digest-'));
  const upgrade = createSystemUpgradeModule({
    cacheDir,
    distTarget: 'x86_64-unknown-linux-gnu',
    fetch: (async () =>
      new Response(JSON.stringify({ tag_name: 'v9.9.9', immutable: false }))) as unknown as typeof fetch
  });

  upgrade.getStatus();
  await waitForStage(upgrade, 'ready');
  await upgrade.start();
  expect(upgrade.getStatus().error).toContain('not immutable');
  await rm(cacheDir, { force: true, recursive: true });
});

test('system upgrade rejects an asset whose bytes do not match the GitHub digest', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'monad-system-upgrade-mismatch-'));
  const upgrade = createSystemUpgradeModule({
    cacheDir,
    distTarget: 'x86_64-unknown-linux-gnu',
    fetch: releaseFetch('v9.9.9', 'monad-x86_64-unknown-linux-gnu.tar.gz'),
    platform: 'linux'
  });

  upgrade.getStatus();
  await waitForStage(upgrade, 'ready');
  await upgrade.start();
  expect(upgrade.getStatus().error).toContain('GitHub digest mismatch');
  await rm(cacheDir, { force: true, recursive: true });
});

test('system upgrade launches a durable worker, returns restarting, then schedules daemon exit', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'monad-system-upgrade-'));
  let argv: string[] | undefined;
  let spawnOptions: SpawnOptions | undefined;
  let exitScheduled = false;
  const upgrade = createSystemUpgradeModule({
    binaryPath: '/opt/monad/bin/monad',
    cacheDir,
    distTarget: 'x86_64-unknown-linux-gnu',
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
        exited: Promise.resolve(0)
      };
    }) as typeof Bun.spawn
  });

  upgrade.getStatus();
  await waitForStage(upgrade, 'ready');
  await upgrade.start();
  const stagedDir = join(
    cacheDir,
    'staged',
    new Bun.CryptoHasher('sha256').update('v9.9.9').digest('hex').slice(0, 24)
  );

  expect(argv?.slice(0, 4)).toEqual(['sh', '-c', 'nohup "$@" >/dev/null 2>&1 < /dev/null &', 'monad-upgrade-launch']);
  expect(argv?.[6]).toContain('MONAD_INSTALLER_ARTIFACT_DIR="$6"');
  expect(argv?.[6]).toContain('printf "%s\\n%s\\n" "$update_code" "$completed" >"$4.tmp"');
  expect(argv?.[6]).toContain('"$3" restart >>"$5" 2>&1');
  expect(argv?.slice(7)).toEqual([
    'monad-upgrade',
    '1234',
    join(stagedDir, 'install.sh'),
    '/opt/monad/bin/monad',
    join(cacheDir, 'result.txt'),
    join(cacheDir, 'updater.log'),
    stagedDir,
    '/opt/monad/bin'
  ]);
  expect(spawnOptions).toMatchObject({ stderr: 'ignore', stdin: 'ignore', stdout: 'ignore' });
  expect(exitScheduled).toBe(true);
  expect(upgrade.getStatus().stage).toBe('restarting');
  expect(upgrade.getStatus().lastAttempt).toMatchObject({ state: 'installing', targetVersion: '9.9.9' });
  await rm(cacheDir, { force: true, recursive: true });
});

test('Windows worker waits for the daemon before updating and restarting', () => {
  const command = workerCommand('win32', 42, 'C:\\Cache\\install.ps1', 'C:\\Cache', 'C:\\Monad\\monad.exe');

  expect(command.slice(0, 6)).toEqual([
    'powershell',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    expect.stringContaining('Wait-Process')
  ]);
  expect(command.slice(-7)).toEqual([
    '42',
    'C:\\Cache\\install.ps1',
    'C:\\Monad\\monad.exe',
    'NUL',
    'NUL',
    'C:\\Cache',
    'C:\\Monad'
  ]);
});

test('Windows upgrade worker launcher starts an encoded detached PowerShell process', () => {
  const command = workerLauncherCommand(
    'win32',
    42,
    "C:\\Monad O'Brien\\install.ps1",
    "C:\\Monad O'Brien",
    'C:\\Monad\\monad.exe'
  );

  expect(command.slice(0, 6)).toEqual([
    'powershell',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    expect.stringContaining('Start-Process')
  ]);
  expect(command[5]).toContain('-EncodedCommand');
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

  const upgrade = createSystemUpgradeModule({
    cacheDir,
    distTarget: 'x86_64-unknown-linux-gnu',
    fetch: releaseFetch()
  });
  expect(upgrade.getStatus()).toMatchObject({ lastAttempt: { state: 'complete' }, stage: 'checking' });
  await waitForStage(upgrade, 'ready');
  await rm(cacheDir, { force: true, recursive: true });
});
