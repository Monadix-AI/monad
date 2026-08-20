import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  configTransactionLockIdentity,
  removeConfigTransactionSemaphoreForTests,
  withConfigTransactionLock
} from '../../src/config/config-transaction-lock.ts';

const roots: string[] = [];

async function lockFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'monad-config-lock-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots) await removeConfigTransactionSemaphoreForTests(root).catch(() => {});
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('a named kernel lock bounds contention without overlapping callbacks', async () => {
  const home = await lockFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let ownerRunning = false;
  let overlapped = false;
  const ownerTask = withConfigTransactionLock(
    home,
    async () => {
      ownerRunning = true;
      entered.resolve();
      await release.promise;
      ownerRunning = false;
    },
    { timeoutMs: 500 }
  );

  try {
    await entered.promise;
    const contender = await withConfigTransactionLock(
      home,
      async () => {
        overlapped = ownerRunning;
        return 'acquired';
      },
      { timeoutMs: 30 }
    ).then(
      (result) => result,
      (error) => (error as Error).message
    );

    expect({ ownerRunning, overlapped, contender }).toEqual({
      ownerRunning: true,
      overlapped: false,
      contender: 'monad: config transaction lock timed out after 30ms'
    });
  } finally {
    release.resolve();
    await ownerTask;
  }
});

test('home and obsolete lock-path replacement cannot split a live owner from a third contender', async () => {
  const home = await lockFixture();
  const movedHome = `${home}.moved`;
  roots.push(movedHome);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let ownerRunning = false;
  const ownerTask = withConfigTransactionLock(
    home,
    async () => {
      ownerRunning = true;
      entered.resolve();
      await release.promise;
      ownerRunning = false;
    },
    { timeoutMs: 500 }
  );

  try {
    await entered.promise;
    await rename(home, movedHome);
    await mkdir(home, { mode: 0o700 });
    await Bun.write(join(home, 'snapshot.lock'), 'replacement');
    const overlapMarker = join(home, 'contender-overlapped');
    const moduleUrl = new URL('../../src/config/config-transaction-lock.ts', import.meta.url).href;
    const contender = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const { withConfigTransactionLock } = await import(${JSON.stringify(moduleUrl)});
          const outcome = await withConfigTransactionLock(
            process.env.MONAD_TEST_HOME,
            async () => {
              await Bun.write(process.env.MONAD_TEST_OVERLAP, 'overlap');
              return 'acquired';
            },
            { timeoutMs: 30 }
          ).catch((error) => error.message);
          process.stdout.write(outcome);
        `
      ],
      {
        env: { ...process.env, MONAD_TEST_HOME: home, MONAD_TEST_OVERLAP: overlapMarker },
        stdout: 'pipe',
        stderr: 'pipe'
      }
    );
    const contenderOutcome = await new Response(contender.stdout).text();
    const contenderExit = await contender.exited;
    const timeoutMatch = contenderOutcome.match(/^monad: config transaction lock timed out after (\d+)ms$/);
    const remainingTimeoutMs = Number(timeoutMatch?.[1]);

    expect({
      ownerRunning,
      contenderExit,
      timedOut: timeoutMatch !== null,
      remainingTimeoutWithinBudget:
        Number.isInteger(remainingTimeoutMs) && remainingTimeoutMs >= 0 && remainingTimeoutMs <= 30,
      overlapMarker: await Bun.file(overlapMarker).exists()
    }).toEqual({
      ownerRunning: true,
      contenderExit: 0,
      timedOut: true,
      remainingTimeoutWithinBudget: true,
      overlapMarker: false
    });
  } finally {
    release.resolve();
    await ownerTask;
  }
});

test('callback failure releases native ownership for the next contender', async () => {
  const home = await lockFixture();

  await expect(
    withConfigTransactionLock(home, async () => {
      throw new Error('callback failed');
    })
  ).rejects.toThrow('callback failed');

  await expect(withConfigTransactionLock(home, async () => 'released')).resolves.toBe('released');
});

test('canonical aliases share one named kernel lock identity', async () => {
  const home = await lockFixture();
  const alias = `${home}.alias`;
  roots.push(alias);
  await symlink(home, alias);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const ownerTask = withConfigTransactionLock(
    alias,
    async () => {
      entered.resolve();
      await release.promise;
    },
    { timeoutMs: 500 }
  );

  try {
    await entered.promise;
    await expect(withConfigTransactionLock(home, async () => 'overlap', { timeoutMs: 30 })).rejects.toThrow(
      'monad: config transaction lock timed out after 30ms'
    );
  } finally {
    release.resolve();
    await ownerTask;
  }
});

test('platform lock identities use a Unix kernel key and a Windows cross-session mutex', () => {
  const canonicalHome = '/canonical/monad-home';
  const unixDigest = createHash('sha256')
    .update(`${process.getuid?.() ?? 0}:${canonicalHome}`)
    .digest();
  const windowsDigest = createHash('sha256').update(canonicalHome).digest();
  const expectedKey = unixDigest.readUInt32BE(0) & 0x7fff_ffff || 1;
  const expectedName = `Global\\MonadConfigTransaction-${windowsDigest.toString('hex')}`;

  expect({
    darwin: configTransactionLockIdentity(canonicalHome, 'darwin'),
    linux: configTransactionLockIdentity(canonicalHome, 'linux'),
    win32: configTransactionLockIdentity(canonicalHome, 'win32')
  }).toEqual({
    darwin: { kind: 'system-v-semaphore', key: expectedKey },
    linux: { kind: 'system-v-semaphore', key: expectedKey },
    win32: { kind: 'windows-global-mutex', name: expectedName }
  });
});
