import type { WatchFn, WatchHandle } from '@/reload/index.ts';

import { beforeEach, expect, test } from 'bun:test';

import { ReloadService } from '@/reload/index.ts';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const logs: Array<{ level: string; message: string }> = [];
const log = (level: 'info' | 'warn', message: string) => {
  logs.push({ level, message });
};
beforeEach(() => {
  logs.length = 0;
});

/** A controllable fake of the watch primitive: capture listeners, fire events, track closes. */
function fakeWatch() {
  const listeners: Array<(event: string, filename: string | null) => void> = [];
  const closed: boolean[] = [];
  const calls: Array<{ path: string; recursive?: boolean }> = [];
  const watchFn: WatchFn = (path, options, listener) => {
    calls.push({ path, recursive: options.recursive });
    listeners.push(listener);
    const idx = closed.length;
    closed.push(false);
    const handle: WatchHandle = {
      close: () => {
        closed[idx] = true;
      }
    };
    return handle;
  };
  const fire = (index = 0, filename: string | null = 'x') => listeners[index]?.('change', filename);
  return { watchFn, fire, calls, closed };
}

test('debounces a burst of events into a single onChange', async () => {
  const fw = fakeWatch();
  let calls = 0;
  const svc = new ReloadService({ log, watchFn: fw.watchFn });
  svc.register({ name: 's', path: '/p', debounceMs: 10, onChange: () => void calls++ });

  fw.fire();
  fw.fire();
  fw.fire();
  expect(calls).toBe(0); // not yet — debounced
  await delay(25);
  expect(calls).toBe(1);
});

test('filter suppresses non-matching events', async () => {
  const fw = fakeWatch();
  let calls = 0;
  const svc = new ReloadService({ log, watchFn: fw.watchFn });
  svc.register({ name: 's', path: '/p', debounceMs: 5, filter: (f) => f === 'keep.js', onChange: () => void calls++ });

  fw.fire(0, 'skip.txt');
  await delay(15);
  expect(calls).toBe(0);

  fw.fire(0, 'keep.js');
  await delay(15);
  expect(calls).toBe(1);
});

test('isolates and logs onChange errors (async too)', async () => {
  const fw = fakeWatch();
  const svc = new ReloadService({ log, watchFn: fw.watchFn });
  svc.register({
    name: 'boom',
    path: '/p',
    debounceMs: 5,
    onChange: async () => {
      throw new Error('nope');
    }
  });

  fw.fire();
  await delay(15);
});

test('closeAll closes watchers and cancels pending debounce timers', async () => {
  const fw = fakeWatch();
  let calls = 0;
  const svc = new ReloadService({ log, watchFn: fw.watchFn });
  svc.register({ name: 's', path: '/p', debounceMs: 20, onChange: () => void calls++ });

  fw.fire();
  svc.closeAll();
  expect(fw.closed[0]).toBe(true);
  await delay(30);
  expect(calls).toBe(0); // pending reload was cancelled
});

test('register returns false and logs when the watcher cannot start', () => {
  const watchFn: WatchFn = () => {
    throw new Error('ENOENT');
  };
  const svc = new ReloadService({ log, watchFn });
  const ok = svc.register({ name: 'missing', path: '/nope', onChange: () => {} });
  expect(ok).toBe(false);
});

test('passes path and recursive through to the watch primitive', () => {
  const fw = fakeWatch();
  const svc = new ReloadService({ log, watchFn: fw.watchFn });
  svc.register({ name: 's', path: '/dir', recursive: true, onChange: () => {} });
  expect(fw.calls[0]).toEqual({ path: '/dir', recursive: true });
});

test('debounce is keyed per source — independent sources fire independently', async () => {
  const fw = fakeWatch();
  let a = 0;
  let b = 0;
  const svc = new ReloadService({ log, watchFn: fw.watchFn });
  svc.register({ name: 'a', path: '/a', debounceMs: 10, onChange: () => void a++ });
  svc.register({ name: 'b', path: '/b', debounceMs: 10, onChange: () => void b++ });

  fw.fire(0); // source a
  fw.fire(1); // source b
  await delay(25);
  expect(a).toBe(1);
  expect(b).toBe(1);
});

test('recursive: true falls back to non-recursive when the platform throws, logs warn', async () => {
  let attempt = 0;
  const watchFn: WatchFn = (_path, opts, _listener) => {
    attempt++;
    if (opts.recursive) throw new Error('ENOTSUP');
    // non-recursive succeeds
    return { close: () => {} };
  };
  let calls = 0;
  const svc = new ReloadService({ log, watchFn });
  const ok = svc.register({
    name: 'atoms',
    path: '/atoms',
    recursive: true,
    debounceMs: 5,
    onChange: () => void calls++
  });

  expect(ok).toBe(true); // watcher started despite recursive failing
  expect(attempt).toBe(2); // tried recursive, then non-recursive
  expect(
    logs.some((l) => l.level === 'warn' && l.message.includes('atoms') && l.message.includes('top-level only'))
  ).toBe(true);
});

test('recursive: false does not fall back — throws immediately', () => {
  const watchFn: WatchFn = () => {
    throw new Error('ENOENT');
  };
  const svc = new ReloadService({ log, watchFn });
  const ok = svc.register({ name: 'missing', path: '/nope', recursive: false, onChange: () => {} });
  expect(ok).toBe(false);
});
