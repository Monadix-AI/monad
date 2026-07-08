import { afterEach, beforeEach, expect, test } from 'bun:test';

if (process.platform === 'win32') process.exit(0);

import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KvServer } from '#/store/kv/index.ts';

const SOCK = join(tmpdir(), 'monad-kv-unix-test.sock');

let server: KvServer;
let redis: InstanceType<typeof Bun.RedisClient>;

beforeEach(async () => {
  await unlink(SOCK).catch(() => {});
  server = new KvServer();
  server.start(SOCK, { sweepIntervalMs: 500 });
  await Bun.sleep(30);
  redis = new Bun.RedisClient(server.clientUrl);
  await Bun.sleep(30);
});

afterEach(async () => {
  redis.close();
  server.stop();
  await unlink(SOCK).catch(() => {});
});

// Bun's TCP transport on Windows doesn't reliably deliver error replies (oven-sh/bun#14836),
// so the send never settles and the test times out. The rejection rule itself is covered
// transport-free in store.test.ts ("xadd rejects non-increasing id"), which runs on every platform.
test('XADD rejects a smaller id', async () => {
  await redis.send('XADD', ['e', '5-5', 'a', '1']);
  await expect(redis.send('XADD', ['e', '5-5', 'b', '2'])).rejects.toThrow();
});
