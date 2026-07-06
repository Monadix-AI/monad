import { expect, test } from 'bun:test';
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

test('system upgrade start is idempotent while the child process is running', async () => {
  let spawnCount = 0;
  let resolveExit!: () => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = () => resolve(0);
  });
  const upgrade = createSystemUpgradeModule({
    getUpgradeInfo: () => ({ latestVersion: '9.9.9', latestVersionCheckedAt: '2026-07-06T00:00:00.000Z' }),
    spawn: (() => {
      spawnCount += 1;
      return { stdout: stream('Downloading\n'), stderr: stream(''), exited };
    }) as unknown as typeof Bun.spawn
  });

  await upgrade.start();
  await upgrade.start();
  expect(spawnCount).toBe(1);
  expect(upgrade.getStatus().stage).toBe('downloading');

  resolveExit();
  await Bun.sleep(0);
  expect(upgrade.getStatus().stage).toBe('complete');
});

test('system upgrade reports failure when the child process exits non-zero', async () => {
  const upgrade = createSystemUpgradeModule({
    getUpgradeInfo: () => ({ latestVersion: '9.9.9', latestVersionCheckedAt: '2026-07-06T00:00:00.000Z' }),
    spawn: (() => ({
      stdout: stream('Installing\n'),
      stderr: stream(''),
      exited: Promise.resolve(7)
    })) as unknown as typeof Bun.spawn
  });

  await upgrade.start();
  await Bun.sleep(0);

  expect(upgrade.getStatus()).toMatchObject({
    stage: 'failed',
    progress: 100,
    error: 'upgrade exited with code 7'
  });
});

test('system upgrade reflects download progress from installer output', async () => {
  let resolveExit!: () => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = () => resolve(0);
  });
  const upgrade = createSystemUpgradeModule({
    getUpgradeInfo: () => ({ latestVersion: '9.9.9', latestVersionCheckedAt: '2026-07-06T00:00:00.000Z' }),
    spawn: (() => ({
      stdout: stream('Downloading Monad CLI\n[====      ] 42%\n'),
      stderr: stream(''),
      exited
    })) as unknown as typeof Bun.spawn
  });

  await upgrade.start();
  await Bun.sleep(0);

  expect(upgrade.getStatus()).toMatchObject({
    stage: 'downloading',
    progress: 42
  });

  resolveExit();
  await Bun.sleep(0);

  expect(upgrade.getStatus().stage).toBe('complete');
  expect(upgrade.getStatus().progress).toBe(100);
});

test('system upgrade can detach the installer from the daemon process', async () => {
  let spawnOptions: SpawnOptions | undefined;
  let unrefCalled = false;
  const upgrade = createSystemUpgradeModule({
    detached: true,
    getUpgradeInfo: () => ({ latestVersion: '9.9.9', latestVersionCheckedAt: '2026-07-06T00:00:00.000Z' }),
    spawn: ((_argv: string[], options?: SpawnOptions) => {
      spawnOptions = options;
      return {
        exited: Promise.resolve(0),
        unref: () => {
          unrefCalled = true;
        }
      };
    }) as unknown as typeof Bun.spawn
  });

  await upgrade.start();
  await Bun.sleep(0);

  expect(spawnOptions).toMatchObject({
    detached: true,
    stderr: 'ignore',
    stdin: 'ignore',
    stdout: 'ignore'
  });
  expect(unrefCalled).toBe(true);
  expect(upgrade.getStatus()).toMatchObject({
    stage: 'installing',
    progress: 75
  });
});
