import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  removeConfigTransactionSemaphoreForTests,
  withConfigTransactionLock
} from '../../src/config/config-transaction-lock.ts';

let home: string | undefined;

afterEach(async () => {
  if (!home) return;
  await removeConfigTransactionSemaphoreForTests(home).catch(() => {});
  await rm(home, { recursive: true, force: true });
  home = undefined;
});

test('a process killed while owning the Unix lock is abandoned for the next contender', async () => {
  home = await mkdtemp(join(tmpdir(), 'monad-config-lock-'));
  const readyPath = join(home, 'owner-ready');
  const moduleUrl = new URL('../../src/config/config-transaction-lock.ts', import.meta.url).href;
  const child = Bun.spawn(
    [
      process.execPath,
      '--eval',
      `
        const { withConfigTransactionLock } = await import(${JSON.stringify(moduleUrl)});
        await withConfigTransactionLock(process.env.MONAD_TEST_HOME, async () => {
          await Bun.write(process.env.MONAD_TEST_READY, 'ready');
          await new Promise(() => {});
        });
      `
    ],
    {
      env: { ...process.env, MONAD_TEST_HOME: home, MONAD_TEST_READY: readyPath },
      stdout: 'pipe',
      stderr: 'pipe'
    }
  );
  try {
    for (let attempt = 0; attempt < 200 && !(await Bun.file(readyPath).exists()); attempt++) await Bun.sleep(5);
    if (!(await Bun.file(readyPath).exists())) throw new Error('child lock owner did not become ready');
    child.kill(9);
    await child.exited;

    await expect(withConfigTransactionLock(home, async () => 'recovered', { timeoutMs: 500 })).resolves.toBe(
      'recovered'
    );
  } finally {
    child.kill(9);
    await child.exited;
  }
});

test('test cleanup waits for a live Unix owner before removing its semaphore', async () => {
  home = await mkdtemp(join(tmpdir(), 'monad-config-lock-'));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let ownerRunning = false;
  let cleanupSettled = false;
  const owner = withConfigTransactionLock(home, async () => {
    ownerRunning = true;
    entered.resolve();
    await release.promise;
    ownerRunning = false;
  });
  await entered.promise;
  const cleanup = removeConfigTransactionSemaphoreForTests(home).then(() => {
    cleanupSettled = true;
  });
  await Bun.sleep(20);
  const duringOwnership = { cleanupSettled, ownerRunning };
  release.resolve();
  await owner;
  await cleanup;
  const nextOwner = await withConfigTransactionLock(home, async () => 'acquired');

  expect({ duringOwnership, cleanupSettled, nextOwner }).toEqual({
    duringOwnership: { cleanupSettled: false, ownerRunning: true },
    cleanupSettled: true,
    nextOwner: 'acquired'
  });
});
