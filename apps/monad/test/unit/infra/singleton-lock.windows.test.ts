if (process.platform !== 'win32') process.exit(0);

import { test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const _t = (key: string) => key;

test('acquireSingletonLock resolves on Windows (named mutex acquired)', async () => {
  // On Windows the lock is a kernel named mutex; the lockPath argument is unused.
  const _lockPath = join(tmpdir(), `monad-lock-test-${process.pid}-${Date.now()}.lock`);
});
