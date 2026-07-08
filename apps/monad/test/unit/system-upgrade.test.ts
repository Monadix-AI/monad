import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MONAD_VERSION } from '@monad/protocol';

import { createSystemUpgradeModule } from '@/handlers/system-upgrade.ts';

type SpawnOptions = NonNullable<Parameters<typeof Bun.spawn>[1]>;

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }
  });
}

function sha256(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(bytes);
  return hasher.digest('hex');
}

function createFetch(): typeof fetch {
  const tarball = new TextEncoder().encode('monad artifact');
  const checksum = new TextEncoder().encode(`${sha256(tarball)}  monad-9.9.9-darwin-arm64.tar.gz\n`);
  const script = new TextEncoder().encode('#!/usr/bin/env bash\n');

  return ((url: string) => {
    if (url.endsWith('.tar.gz.sha256')) return Promise.resolve(new Response(checksum));
    if (url.endsWith('.tar.gz')) return Promise.resolve(new Response(tarball));
    if (url.endsWith('/install.sh')) return Promise.resolve(new Response(script));
    return Promise.resolve(new Response('missing', { status: 404 }));
  }) as unknown as typeof fetch;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'monad-upgrade-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

async function waitForStage(upgrade: ReturnType<typeof createSystemUpgradeModule>, stage: string): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (upgrade.getStatus().stage === stage) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${stage}; got ${upgrade.getStatus().stage}`);
}

test('system upgrade status reflects background latest version availability', () => {
  const upgrade = createSystemUpgradeModule({
    getUpgradeInfo: () => ({ latestVersion: '9.9.9', latestVersionCheckedAt: '2026-07-06T00:00:00.000Z' })
  });

  expect(upgrade.getStatus()).toMatchObject({
    available: true,
    currentVersion: MONAD_VERSION,
    latestVersion: '9.9.9',
    stage: 'idle',
    progress: 0,
    error: null
  });
});

test('system upgrade prepares a cached artifact when status is requested with a cache directory', async () => {
  await withTempDir(async (cacheDir) => {
    const upgrade = createSystemUpgradeModule({
      cacheDir,
      fetch: createFetch(),
      getUpgradeInfo: () => ({ latestVersion: '9.9.9', latestVersionCheckedAt: '2026-07-06T00:00:00.000Z' }),
      platform: 'darwin',
      arch: 'arm64'
    });

    expect(upgrade.getStatus()).toMatchObject({
      available: true,
      stage: 'checking'
    });

    await waitForStage(upgrade, 'ready');

    expect(upgrade.getStatus()).toMatchObject({
      available: true,
      latestVersion: '9.9.9',
      stage: 'ready',
      progress: 100,
      error: null
    });
    expect(await Bun.file(join(cacheDir, 'monad-9.9.9-darwin-arm64.tar.gz')).exists()).toBe(true);
    expect(await Bun.file(join(cacheDir, 'v9.9.9-install.sh')).exists()).toBe(true);
  });
});

test('system upgrade start downloads first when the artifact is not ready', async () => {
  await withTempDir(async (cacheDir) => {
    let spawnCount = 0;
    const upgrade = createSystemUpgradeModule({
      cacheDir,
      fetch: createFetch(),
      getUpgradeInfo: () => ({ latestVersion: '9.9.9', latestVersionCheckedAt: '2026-07-06T00:00:00.000Z' }),
      platform: 'darwin',
      arch: 'arm64',
      spawn: (() => {
        spawnCount += 1;
        return { stdout: stream('Installing\n'), stderr: stream(''), exited: Promise.resolve(0) };
      }) as unknown as typeof Bun.spawn
    });

    await upgrade.start();
    expect(spawnCount).toBe(0);
    expect(upgrade.getStatus().stage).not.toBe('installing');

    await waitForStage(upgrade, 'ready');
    expect(spawnCount).toBe(0);
  });
});

test('system upgrade installs the cached artifact and is idempotent while running', async () => {
  await withTempDir(async (cacheDir) => {
    let spawnCount = 0;
    let resolveExit!: () => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = () => resolve(0);
    });
    const upgrade = createSystemUpgradeModule({
      cacheDir,
      fetch: createFetch(),
      getUpgradeInfo: () => ({ latestVersion: '9.9.9', latestVersionCheckedAt: '2026-07-06T00:00:00.000Z' }),
      platform: 'darwin',
      arch: 'arm64',
      spawn: (() => {
        spawnCount += 1;
        return { stdout: stream('Installing\n'), stderr: stream(''), exited };
      }) as unknown as typeof Bun.spawn
    });

    upgrade.getStatus();
    await waitForStage(upgrade, 'ready');

    await upgrade.start();
    await upgrade.start();
    expect(spawnCount).toBe(1);
    expect(upgrade.getStatus().stage).toBe('installing');

    resolveExit();
    await Bun.sleep(0);
    expect(upgrade.getStatus().stage).toBe('complete');
  });
});

test('system upgrade reports failure when cached installer exits non-zero', async () => {
  await withTempDir(async (cacheDir) => {
    const upgrade = createSystemUpgradeModule({
      cacheDir,
      fetch: createFetch(),
      getUpgradeInfo: () => ({ latestVersion: '9.9.9', latestVersionCheckedAt: '2026-07-06T00:00:00.000Z' }),
      platform: 'darwin',
      arch: 'arm64',
      spawn: (() => ({
        stdout: stream('Installing\n'),
        stderr: stream(''),
        exited: Promise.resolve(7)
      })) as unknown as typeof Bun.spawn
    });

    upgrade.getStatus();
    await waitForStage(upgrade, 'ready');
    await upgrade.start();
    await Bun.sleep(0);

    expect(upgrade.getStatus()).toMatchObject({
      stage: 'failed',
      progress: 100,
      error: 'upgrade exited with code 7'
    });
  });
});

test('system upgrade can detach the cached installer from the daemon process', async () => {
  await withTempDir(async (cacheDir) => {
    let spawnArgv: string[] | undefined;
    let spawnOptions: SpawnOptions | undefined;
    let unrefCalled = false;
    const upgrade = createSystemUpgradeModule({
      cacheDir,
      detached: true,
      fetch: createFetch(),
      getUpgradeInfo: () => ({ latestVersion: '9.9.9', latestVersionCheckedAt: '2026-07-06T00:00:00.000Z' }),
      platform: 'darwin',
      arch: 'arm64',
      spawn: ((argv: string[], options?: SpawnOptions) => {
        spawnArgv = argv;
        spawnOptions = options;
        return {
          exited: Promise.resolve(0),
          unref: () => {
            unrefCalled = true;
          }
        };
      }) as unknown as typeof Bun.spawn
    });

    upgrade.getStatus();
    await waitForStage(upgrade, 'ready');
    await upgrade.start();
    await Bun.sleep(0);

    expect(spawnArgv).toEqual(['bash', join(cacheDir, 'v9.9.9-install.sh'), '--version', '9.9.9']);
    expect(spawnOptions).toMatchObject({
      detached: true,
      env: {
        MONAD_NO_OPEN: '1',
        MONAD_TARBALL: join(cacheDir, 'monad-9.9.9-darwin-arm64.tar.gz'),
        MONAD_VERSION: '9.9.9'
      },
      stderr: 'ignore',
      stdin: 'ignore',
      stdout: 'ignore'
    });
    expect(unrefCalled).toBe(true);
    expect(upgrade.getStatus()).toMatchObject({
      stage: 'restarting',
      progress: 90
    });
  });
});
