import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KvServer } from '#/store/kv/index.ts';

// AF_UNIX is available on every platform monad's CI runs on (macOS, Linux, Windows 10+ with Bun),
// so start() binds the Unix socket everywhere; bindTcpFallback() is the graceful degradation the
// daemon uses when a bound socket's RESP client can't dial it (Bun rejects redis+unix:// on Windows).
const SOCK = join(tmpdir(), `monad-kv-transport-${process.pid}.sock`);
let server: KvServer;

beforeEach(async () => {
  await unlink(SOCK).catch(() => {});
  server = new KvServer();
});

afterEach(async () => {
  server.stop();
  await unlink(SOCK).catch(() => {});
});

test('start() binds a Unix socket and reports a redis+unix:// clientUrl', () => {
  server.start(SOCK, { sweepIntervalMs: 500 });
  expect(server.clientUrl.startsWith('redis+unix://')).toBe(true);
});

test('bindTcpFallback() rebinds on TCP loopback and the RESP store still works', async () => {
  server.start(SOCK, { sweepIntervalMs: 500 });
  const url = server.bindTcpFallback();
  expect(url).toMatch(/^redis:\/\/127\.0\.0\.1:\d+$/);
  expect(server.clientUrl).toBe(url);
  await Bun.sleep(30);
  const client = new Bun.RedisClient(url);
  await client.set('k', 'v');
  expect(await client.get('k')).toBe('v');
  client.close();
  // The abandoned Unix socket node is cleaned up, not left lingering in the runtime dir.
  expect(existsSync(SOCK)).toBe(false);
});

test('bindTcpFallback() is a no-op once already on TCP', () => {
  server.start(SOCK, { sweepIntervalMs: 500 });
  const first = server.bindTcpFallback();
  const second = server.bindTcpFallback();
  expect(second).toBe(first);
});
