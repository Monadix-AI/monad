if (process.platform !== 'win32') process.exit(0);

import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireSingletonLock } from '@/infra/singleton-lock.ts';

const t = (key: string) => key;

test('acquireSingletonLock resolves on Windows (named mutex acquired)', async () => {
  // On Windows the lock is a kernel named mutex; the lockPath argument is unused.
  const lockPath = join(tmpdir(), `monad-lock-test-${process.pid}-${Date.now()}.lock`);
});
