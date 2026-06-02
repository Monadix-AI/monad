if (process.platform === 'win32') process.exit(0);

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireSingletonLock } from '#/infra/singleton-lock.ts';

const t = (key: string) => key;
let lockPath: string;

beforeEach(() => {
  lockPath = join(tmpdir(), `monad-lock-test-${process.pid}-${Date.now()}.lock`);
});

afterEach(() => {
  try {
    unlinkSync(lockPath);
  } catch {}
});

test('acquireSingletonLock creates the lock file on Unix', async () => {
  await acquireSingletonLock(t, lockPath);
  expect(existsSync(lockPath)).toBe(true);
});

test('acquireSingletonLock writes the current PID into the lock file', async () => {
  await acquireSingletonLock(t, lockPath);
  const contents = await Bun.file(lockPath).text();
  expect(contents.trim()).toBe(String(process.pid));
});
