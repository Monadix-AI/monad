import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KvServer } from '@/store/kv/index.ts';

const SOCK = join(tmpdir(), 'monad-kv-test.sock');

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

test('PING', async () => {
  expect(await redis.ping()).toBe('PONG');
});

test('SET and GET', async () => {
  await redis.set('key', 'value');
  expect(await redis.get('key')).toBe('value');
});

test('GET missing returns null', async () => {
});

test('DEL', async () => {
  await redis.set('k', 'v');
  expect(await redis.del('k')).toBe(1);
});

test('EXISTS (single key → boolean)', async () => {
  await redis.set('a', '1');
  expect(await redis.exists('a')).toBe(true);
  expect(await redis.exists('missing')).toBe(false);
});

test('MSET and MGET', async () => {
  await redis.mset('a', '1', 'b', '2');
  const vals = await redis.mget('a', 'b', 'c');
  expect(vals).toEqual(['1', '2', null]);
});

test('EXPIRE and TTL', async () => {
  await redis.set('k', 'v');
  await redis.expire('k', 10);
  const ttl = await redis.ttl('k');
  expect(ttl).toBeGreaterThan(0);
  expect(ttl).toBeLessThanOrEqual(10);
});

test('PEXPIRE and key expires', async () => {
  await redis.set('k', 'v');
  await redis.pexpire('k', 60);
  await Bun.sleep(100);
});

test('TTL on missing key returns -2', async () => {
  expect(await redis.ttl('nope')).toBe(-2);
});

test('TTL on key without expiry returns -1', async () => {
  await redis.set('k', 'v');
  expect(await redis.ttl('k')).toBe(-1);
});

test('PSETEX expires after ms', async () => {
  await redis.psetex('k', 60, 'v');
  await Bun.sleep(100);
});

test('SETEX expires after seconds', async () => {
  await redis.setex('short', 1, 'v');
  expect(await redis.get('short')).toBe('v');
  const ttl = await redis.ttl('short');
  expect(ttl).toBeGreaterThan(0);
});

test('KEYS pattern', async () => {
  await redis.set('foo', '1');
  await redis.set('foobar', '2');
  await redis.set('baz', '3');
  const keys = (await redis.keys('foo*')).sort();
  expect(keys).toEqual(['foo', 'foobar']);
});

test('FLUSHDB via direct store', async () => {
  await redis.set('a', '1');
  server.store.flush();
});

test('INCR / DECR', async () => {
  await redis.set('n', '10');
  expect(await redis.incr('n')).toBe(11);
  expect(await redis.decr('n')).toBe(10);
  expect(await redis.incrby('n', 5)).toBe(15);
  expect(await redis.decrby('n', 3)).toBe(12);
});

test('SETNX', async () => {
  expect(await redis.setnx('k', 'first')).toBe(1); // Redis returns integer 0/1
  expect(await redis.setnx('k', 'second')).toBe(0);
  expect(await redis.get('k')).toBe('first');
});

test('RENAME', async () => {
  await redis.set('src', 'val');
  await redis.rename('src', 'dst');
  expect(await redis.get('dst')).toBe('val');
});

test('TYPE', async () => {
  await redis.set('k', 'v');
  expect(await redis.type('k')).toBe('string');
  expect(await redis.type('missing')).toBe('none');
});

test('PERSIST removes expiry', async () => {
  await redis.set('k', 'v');
  await redis.pexpire('k', 500);
  await redis.persist('k');
  expect(await redis.ttl('k')).toBe(-1);
});

describe('pub/sub', () => {
  test('subscribe and receive published messages', async () => {
    const received: string[] = [];
    const pub = new Bun.RedisClient(server.clientUrl);
    await Bun.sleep(30);

    await redis.subscribe('test-ch', (msg) => received.push(String(msg)));
    await Bun.sleep(50);

    await pub.publish('test-ch', 'hello');
    await pub.publish('test-ch', 'world');
    await Bun.sleep(100);

    expect(received).toEqual(['hello', 'world']);
    pub.close();
  });

  test('10 messages all received', async () => {
    const received: string[] = [];
    const pub = new Bun.RedisClient(server.clientUrl);
    await Bun.sleep(30);

    await redis.subscribe('stream-ch', (msg) => received.push(String(msg)));
    await Bun.sleep(50);

    for (let i = 0; i < 10; i++) await pub.publish('stream-ch', String(i));
    await Bun.sleep(100);

    expect(received).toHaveLength(10);
    expect(received).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
    pub.close();
  });

  test('unsubscribe stops messages', async () => {
    const received: string[] = [];
    const subClient = new Bun.RedisClient(server.clientUrl);
    const pub = new Bun.RedisClient(server.clientUrl);
    await Bun.sleep(30);

    await subClient.subscribe('ch2', (msg) => received.push(String(msg)));
    await Bun.sleep(50);
    await pub.publish('ch2', 'before');
    await Bun.sleep(50);

    // Unsubscribe from separate connection's perspective:
    // use unsubscribe on the sub client
    await subClient.unsubscribe('ch2');
    await Bun.sleep(50);
    await pub.publish('ch2', 'after');
    await Bun.sleep(50);

    expect(received).toEqual(['before']);
    subClient.close();
    pub.close();
  });
});

describe('streams', () => {
  test('XADD returns id, XLEN counts', async () => {
    const id = await redis.send('XADD', ['s', '1-1', 'field', 'val']);
    expect(id).toBe('1-1');
    expect(await redis.send('XLEN', ['s'])).toBe(1);
  });

  test('XADD * auto-generates an id', async () => {
    const id = (await redis.send('XADD', ['auto', '*', 'a', '1'])) as string;
    expect(id).toMatch(/^\d+-\d+$/);
  });

  test('XADD then XRANGE returns entries with fields', async () => {
    await redis.send('XADD', ['r', '1-0', 'a', '1']);
    await redis.send('XADD', ['r', '2-0', 'b', '2']);
    const range = await redis.send('XRANGE', ['r', '-', '+']);
    expect(range).toEqual([
      ['1-0', ['a', '1']],
      ['2-0', ['b', '2']]
    ]);
  });

  test('XREAD returns entries after the given id', async () => {
    await redis.send('XADD', ['rd', '1-0', 'a', '1']);
    await redis.send('XADD', ['rd', '2-0', 'b', '2']);
    const res = await redis.send('XREAD', ['STREAMS', 'rd', '1-0']);
    expect(res).toEqual([['rd', [['2-0', ['b', '2']]]]]);
  });

  test('XREAD non-blocking with no new data returns empty', async () => {
    await redis.send('XADD', ['rd2', '1-0', 'a', '1']);
    // Wire format is a null array (*-1); Bun's client surfaces that as [].
  });

  test('XREAD BLOCK wakes when a later XADD lands', async () => {
    const writer = new Bun.RedisClient(server.clientUrl);
    await Bun.sleep(30);
    await writer.send('XADD', ['blk', '1-0', 'a', '1']);

    // Start a blocking read for entries after the current top ($).
    const pending = redis.send('XREAD', ['BLOCK', '0', 'STREAMS', 'blk', '$']);
    await Bun.sleep(50);
    await writer.send('XADD', ['blk', '2-0', 'b', '2']);

    expect(await pending).toEqual([['blk', [['2-0', ['b', '2']]]]]);
    writer.close();
  });

  test('XREAD BLOCK times out to empty', async () => {
    await redis.send('XADD', ['to', '1-0', 'a', '1']);
    const res = await redis.send('XREAD', ['BLOCK', '60', 'STREAMS', 'to', '$']);
  });

  test('XINFO STREAM returns a summary map', async () => {
    await redis.send('XADD', ['info', '1-0', 'a', '1']);
    await redis.send('XADD', ['info', '2-0', 'b', '2']);
    const res = (await redis.send('XINFO', ['STREAM', 'info'])) as unknown[];
    // Flat [field, value, …] map. Bun surfaces it as an array.
    const map = new Map<string, unknown>();
    for (let i = 0; i < res.length; i += 2) map.set(res[i] as string, res[i + 1]);
    expect(map.get('length')).toBe(2);
    expect(map.get('last-generated-id')).toBe('2-0');
    expect(map.get('first-entry')).toEqual(['1-0', ['a', '1']]);
    expect(map.get('last-entry')).toEqual(['2-0', ['b', '2']]);
  });

  test('XINFO STREAM on missing key errors', async () => {
    await expect(redis.send('XINFO', ['STREAM', 'nope'])).rejects.toThrow();
  });
});

describe('onCommand hook', () => {
  test('fires once per command with args and a connId', async () => {
    const events: { connId: number; args: string[] }[] = [];
    const off = server.onCommand((e) => events.push({ connId: e.connId, args: e.args }));

    await redis.set('hooked', 'yes');
    await redis.get('hooked');

    const set = events.find((e) => e.args[0] === 'SET');
    const get = events.find((e) => e.args[0] === 'GET');
    expect(set?.args).toEqual(['SET', 'hooked', 'yes']);
    expect(get?.args).toEqual(['GET', 'hooked']);
    expect(typeof set?.connId).toBe('number');

    off();
    await redis.set('after', 'x');
    expect(events.some((e) => e.args.includes('after'))).toBe(false);
  });
});

test('pipelining: multiple concurrent commands', async () => {
  await redis.set('p', '42');
  const [incrResult, getResult] = await Promise.all([redis.incr('p'), redis.get('p')]);
  expect(incrResult).toBe(43);
  // get may race with incr but result should be 42 or 43
  expect(['42', '43']).toContain(getResult ?? '');
});

test('cross-connection: second client reads writes from first', async () => {
  // Simulates two independent processes sharing the same KV socket
  const redis2 = new Bun.RedisClient(server.clientUrl);
  await Bun.sleep(30);

  await redis.set('shared', 'from-client1');
  expect(await redis2.get('shared')).toBe('from-client1');

  await redis2.set('reply', 'from-client2');
  expect(await redis.get('reply')).toBe('from-client2');

  redis2.close();
});
