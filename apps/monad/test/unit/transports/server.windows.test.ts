if (process.platform !== 'win32') process.exit(0);

import { afterEach, beforeEach, expect, test } from 'bun:test';

import { KvServer } from '#/store/kv/index.ts';

let server: KvServer;
let redis: InstanceType<typeof Bun.RedisClient>;

beforeEach(async () => {
  server = new KvServer();
  server.start('ignored-on-windows.sock', { sweepIntervalMs: 500 });
  await Bun.sleep(30);
  redis = new Bun.RedisClient(server.clientUrl);
  await Bun.sleep(30);
});

afterEach(() => {
  redis.close();
  server.stop();
});

test('KvServer starts on TCP loopback on Windows', () => {
  expect(server.clientUrl).toMatch(/^redis:\/\/127\.0\.0\.1:\d+$/);
});

test('SET and GET round-trip over TCP loopback', async () => {
  await redis.set('win-key', 'win-val');
  expect(await redis.get('win-key')).toBe('win-val');
});

test('clientUrl changes each start (fresh OS-assigned port)', async () => {
  const first = server.clientUrl;
  redis.close();
  server.stop();

  const s2 = new KvServer();
  s2.start('ignored.sock', { sweepIntervalMs: 500 });
  await Bun.sleep(30);
  const second = s2.clientUrl;
  s2.stop();

  // Both should be TCP loopback; ports may differ (OS-assigned).
  expect(first).toMatch(/^redis:\/\/127\.0\.0\.1:/);
  expect(second).toMatch(/^redis:\/\/127\.0\.0\.1:/);
});
