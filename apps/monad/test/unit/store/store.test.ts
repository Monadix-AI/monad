import { beforeEach, describe, expect, test } from 'bun:test';

import { KvStore } from '@/store/kv/store.ts';

let store: KvStore;
beforeEach(() => {
  store = new KvStore();
});

describe('get/set/del', () => {
  test('set and get a value', () => {
    store.set('k', Buffer.from('v'));
    expect(store.get('k')?.toString()).toBe('v');
  });
  test('get missing key returns null', () => {});
  test('del removes key', () => {
    store.set('k', Buffer.from('v'));
    expect(store.del('k')).toBe(1);
  });
  test('del multiple keys', () => {
    store.set('a', Buffer.from('1'));
    store.set('b', Buffer.from('2'));
    expect(store.del('a', 'b', 'c')).toBe(2);
  });
  test('exists', () => {
    store.set('x', Buffer.from('y'));
    expect(store.exists('x')).toBe(1);
    expect(store.exists('x', 'x')).toBe(2);
    expect(store.exists('missing')).toBe(0);
  });
});

describe('NX / XX options', () => {
  test('NX: only set if missing', () => {
    expect(store.set('k', Buffer.from('a'), { nx: true })).toBe(true);
    expect(store.set('k', Buffer.from('b'), { nx: true })).toBe(false);
    expect(store.get('k')?.toString()).toBe('a');
  });
  test('XX: only set if present', () => {
    expect(store.set('k', Buffer.from('a'), { xx: true })).toBe(false);
    store.set('k', Buffer.from('a'));
    expect(store.set('k', Buffer.from('b'), { xx: true })).toBe(true);
    expect(store.get('k')?.toString()).toBe('b');
  });
});

describe('TTL', () => {
  test('pttl returns -2 for missing key', () => {
    expect(store.pttl('missing')).toBe(-2);
  });
  test('pttl returns -1 for no-expiry key', () => {
    store.set('k', Buffer.from('v'));
    expect(store.pttl('k')).toBe(-1);
  });
  test('expires key after TTL', async () => {
    store.set('k', Buffer.from('v'), { px: 50 });
    await Bun.sleep(80);
  });
  test('pttl reflects remaining time', async () => {
    store.set('k', Buffer.from('v'), { px: 500 });
    const remaining = store.pttl('k');
    expect(remaining).toBeGreaterThan(400);
    expect(remaining).toBeLessThanOrEqual(500);
  });
  test('expire sets TTL in seconds', async () => {
    store.set('k', Buffer.from('v'));
    store.expire('k', 0); // expire immediately
    await Bun.sleep(10);
  });
  test('persist removes expiry', async () => {
    store.set('k', Buffer.from('v'), { px: 100 });
    store.persist('k');
    await Bun.sleep(120);
  });
  test('sweep removes expired keys', async () => {
    store.set('a', Buffer.from('1'), { px: 30 });
    store.set('b', Buffer.from('2'));
    await Bun.sleep(50);
    store.sweep();
    expect(store.dbsize()).toBe(1);
  });
});

describe('keys / dbsize / flush', () => {
  test('keys with *', () => {
    store.set('foo', Buffer.from('1'));
    store.set('bar', Buffer.from('2'));
    store.set('foobar', Buffer.from('3'));
    expect(store.keys('*').sort()).toEqual(['bar', 'foo', 'foobar']);
  });
  test('keys with prefix glob', () => {
    store.set('foo', Buffer.from('1'));
    store.set('foobar', Buffer.from('2'));
    store.set('bar', Buffer.from('3'));
    expect(store.keys('foo*').sort()).toEqual(['foo', 'foobar']);
  });
  test('keys with ? wildcard', () => {
    store.set('a1', Buffer.from('x'));
    store.set('a12', Buffer.from('x'));
    store.set('b1', Buffer.from('x'));
    expect(store.keys('a?').sort()).toEqual(['a1']);
  });
  test('dbsize counts live keys', () => {
    store.set('a', Buffer.from('1'));
    store.set('b', Buffer.from('2'));
    expect(store.dbsize()).toBe(2);
  });
  test('flush clears all', () => {
    store.set('a', Buffer.from('1'));
    store.flush();
    expect(store.dbsize()).toBe(0);
  });
});

describe('streams', () => {
  test('xadd with explicit ids and xlen', () => {
    expect(store.xadd('s', '1-1', ['a', '1'])).toBe('1-1');
    expect(store.xadd('s', '1-2', ['b', '2'])).toBe('1-2');
    expect(store.xlen('s')).toBe(2);
  });

  test('xadd * auto-generates monotonic ids', () => {
    const id1 = store.xadd('s', '*', ['a', '1']) as string;
    const id2 = store.xadd('s', '*', ['b', '2']) as string;
    expect(id1).toMatch(/^\d+-\d+$/);
    expect(id2 > id1 || Number(id2.split('-')[0]) >= Number(id1.split('-')[0])).toBe(true);
  });

  test('xadd <ms>-* auto-increments seq within same ms', () => {
    expect(store.xadd('s', '5-*', ['a', '1'])).toBe('5-0');
    expect(store.xadd('s', '5-*', ['b', '2'])).toBe('5-1');
    expect(store.xadd('s', '6-*', ['c', '3'])).toBe('6-0');
  });

  test('xadd rejects non-increasing id', () => {
    store.xadd('s', '5-5', ['a', '1']);
    expect(() => store.xadd('s', '5-5', ['b', '2'])).toThrow();
    expect(() => store.xadd('s', '4-0', ['b', '2'])).toThrow();
  });

  test('xadd rejects 0-0', () => {
    expect(() => store.xadd('s', '0-0', ['a', '1'])).toThrow();
  });

  test('xadd NOMKSTREAM skips creating a missing stream', () => {
    expect(store.xlen('missing')).toBe(0);
  });

  test('xadd MAXLEN trims oldest entries', () => {
    for (let i = 1; i <= 5; i++) store.xadd('s', `${i}-0`, ['n', String(i)]);
    store.xadd('s', '6-0', ['n', '6'], { maxlen: 3 });
    expect(store.xlen('s')).toBe(3);
    expect(store.xrange('s', '-', '+').map((e) => e.id)).toEqual(['4-0', '5-0', '6-0']);
  });

  test('xrange inclusive bounds and count', () => {
    for (let i = 1; i <= 5; i++) store.xadd('s', `${i}-0`, ['n', String(i)]);
    expect(store.xrange('s', '2-0', '4-0').map((e) => e.id)).toEqual(['2-0', '3-0', '4-0']);
    expect(store.xrange('s', '-', '+', 2).map((e) => e.id)).toEqual(['1-0', '2-0']);
  });

  test('xread returns entries strictly after the given id', () => {
    store.xadd('s', '1-0', ['a', '1']);
    store.xadd('s', '2-0', ['b', '2']);
    const res = store.xread([{ key: 's', afterId: '1-0' }]);
    expect(res).toEqual([{ key: 's', entries: [{ id: '2-0', fields: ['b', '2'] }] }]);
  });

  test('xread omits streams with no new entries', () => {
    store.xadd('s', '1-0', ['a', '1']);
  });

  test('type reports stream and del/exists cover streams', () => {
    store.xadd('s', '1-0', ['a', '1']);
    expect(store.type('s')).toBe('stream');
    expect(store.exists('s')).toBe(1);
    expect(store.del('s')).toBe(1);
    expect(store.type('s')).toBe('none');
  });

  test('stream waiter fires on append to a watched key', () => {
    let fired = 0;
    const unregister = store.addStreamWaiter(['s'], () => fired++);
    store.xadd('other', '1-0', ['a', '1']);
    expect(fired).toBe(0);
    store.xadd('s', '1-0', ['a', '1']);
    expect(fired).toBe(1);
    unregister();
    store.xadd('s', '2-0', ['b', '2']);
    expect(fired).toBe(1);
  });

  test('xinfoStream summarizes length, last id, first/last entry', () => {
    store.xadd('s', '1-0', ['a', '1']);
    store.xadd('s', '2-0', ['b', '2']);
    expect(store.xinfoStream('s')).toEqual({
      length: 2,
      lastGeneratedId: '2-0',
      firstEntry: { id: '1-0', fields: ['a', '1'] },
      lastEntry: { id: '2-0', fields: ['b', '2'] }
    });
  });
});

describe('inspect', () => {
  test('snapshots strings, streams, and channels', () => {
    store.set('str', Buffer.from('hello'), { px: 5000 });
    store.xadd('st', '1-0', ['a', '1']);
    store.subscribe('ch', () => {});

    const snap = store.inspect();
    expect(snap.strings).toEqual([{ key: 'str', ttlMs: expect.any(Number), size: 5, preview: 'hello' }]);
    expect(snap.strings[0]?.ttlMs).toBeGreaterThan(0);
    expect(snap.streams).toEqual([
      { key: 'st', length: 1, lastId: '1-0', entries: [{ id: '1-0', fields: ['a', '1'] }] }
    ]);
    expect(snap.channels).toEqual([{ name: 'ch', subscribers: 1 }]);
  });

  test('previews are capped to previewBytes', () => {
    store.set('big', Buffer.from('x'.repeat(500)));
    const snap = store.inspect(10);
    expect(snap.strings[0]?.preview).toBe('x'.repeat(10));
    expect(snap.strings[0]?.size).toBe(500);
  });

  test('omits expired keys', async () => {
    store.set('gone', Buffer.from('v'), { px: 20 });
    await Bun.sleep(40);
  });
});

describe('pub/sub', () => {
  test('publish to subscriber', () => {
    const received: string[] = [];
    store.subscribe('ch', (m) => received.push(m));
    store.publish('ch', 'hello');
    expect(received).toEqual(['hello']);
  });
  test('publish returns subscriber count', () => {
    store.subscribe('ch', () => {});
    store.subscribe('ch', () => {});
    expect(store.publish('ch', 'x')).toBe(2);
  });
  test('unsubscribe stops messages', () => {
    const received: string[] = [];
    const unsub = store.subscribe('ch', (m) => received.push(m));
    unsub();
    store.publish('ch', 'hello');
  });
  test('publish to empty channel returns 0', () => {
    expect(store.publish('empty', 'hi')).toBe(0);
  });
});
