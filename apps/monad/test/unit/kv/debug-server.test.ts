import { afterEach, beforeEach, expect, test } from 'bun:test';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startKvDebugServer } from '@/store/kv/debug-server.ts';
import { KvServer, type StoreSnapshot } from '@/store/kv/index.ts';

const getJson = async <T>(url: string): Promise<T> => (await fetch(url)).json() as Promise<T>;

const SOCK = join(tmpdir(), 'monad-kv-debug-test.sock');

let server: KvServer;
let ui: ReturnType<typeof startKvDebugServer>;
let redis: InstanceType<typeof Bun.RedisClient>;

beforeEach(async () => {
  await unlink(SOCK).catch(() => {});
  server = new KvServer();
  server.start(SOCK, { sweepIntervalMs: 500 });
  ui = startKvDebugServer(server, { port: 0 }); // port 0 → OS-assigned
  await Bun.sleep(30);
  redis = new Bun.RedisClient(server.clientUrl);
  await Bun.sleep(30);
});

afterEach(async () => {
  redis.close();
  ui.stop();
  server.stop();
  await unlink(SOCK).catch(() => {});
});

test('GET / serves the HTML page', async () => {
  const res = await fetch(`${ui.url}/`);
  expect(res.headers.get('content-type')).toContain('text/html');
  const body = await res.text();
  expect(body).toContain('monad kv — debug');
});

test('GET /api/dump returns the store snapshot', async () => {
  await redis.set('k', 'v');
  await redis.send('XADD', ['s', '1-0', 'a', '1']);

  const dump = await getJson<StoreSnapshot>(`${ui.url}/api/dump`);
  expect(dump.strings).toEqual([{ key: 'k', ttlMs: -1, size: 1, preview: 'v' }]);
  expect(dump.streams).toEqual([{ key: 's', length: 1, lastId: '1-0', entries: [{ id: '1-0', fields: ['a', '1'] }] }]);
});

test('GET /api/stream returns entries for one stream', async () => {
  await redis.send('XADD', ['s', '1-0', 'a', '1']);
  await redis.send('XADD', ['s', '2-0', 'b', '2']);
  const res = await getJson<{ name: string; entries: { id: string }[] }>(`${ui.url}/api/stream?name=s`);
  expect(res.name).toBe('s');
  expect(res.entries.map((e) => e.id)).toEqual(['1-0', '2-0']);
});

test('GET /api/key returns the full value and ttl', async () => {
  await redis.set('k', 'hello');
  type KeyResp = { name: string; value: string | null; ttlMs: number };
  const res = await getJson<KeyResp>(`${ui.url}/api/key?name=k`);
  expect(res).toEqual({ name: 'k', value: 'hello', ttlMs: -1 });

  const missing = await getJson<KeyResp>(`${ui.url}/api/key?name=nope`);
  expect(missing.value).toBeNull();
});

test('WebSocket streams command events live', async () => {
  const ws = new WebSocket(`${ui.url.replace('http', 'ws')}/ws`);
  const events: { args: string[] }[] = [];
  ws.addEventListener('message', (ev) => events.push(JSON.parse(String(ev.data))));
  await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()));

  await redis.set('live', 'go');
  await Bun.sleep(50);

  expect(events.some((e) => e.args[0] === 'SET' && e.args[1] === 'live')).toBe(true);
  ws.close();
});
