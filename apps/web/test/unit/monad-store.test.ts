import { expect, test } from 'bun:test';

import { resolveConnection } from '../../lib/monad-store.ts';

test('resolveConnection requires an explicit browser runtime instead of falling back to a daemon URL', () => {
  const originalWindow = globalThis.window;
  try {
    // @ts-expect-error test-only removal of the browser global
    delete globalThis.window;
    expect(() => resolveConnection()).toThrow('resolveConnection requires a browser runtime');
  } finally {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
      writable: true
    });
  }
});

test('resolveConnection uses the configured HTTPS daemon scheme for direct WebSocket control stream', () => {
  const originalWindow = globalThis.window;
  const originalLocalStorage = globalThis.localStorage;
  const originalApiBase = process.env.NEXT_PUBLIC_MONAD_API_BASE;
  const originalPort = process.env.NEXT_PUBLIC_MONAD_DAEMON_PORT;
  const originalScheme = process.env.NEXT_PUBLIC_MONAD_DAEMON_SCHEME;

  const storage = {
    getItem: () => null
  };

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'https://127.0.0.1:3000' } },
    writable: true
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
    writable: true
  });
  process.env.NEXT_PUBLIC_MONAD_API_BASE = '/api';
  process.env.NEXT_PUBLIC_MONAD_DAEMON_PORT = '52522';
  process.env.NEXT_PUBLIC_MONAD_DAEMON_SCHEME = 'https';

  try {
    expect(resolveConnection()).toEqual({
      baseUrl: 'https://127.0.0.1:3000/api',
      wsBaseUrl: 'https://127.0.0.1:52522'
    });
  } finally {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
      writable: true
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalLocalStorage,
      writable: true
    });
    process.env.NEXT_PUBLIC_MONAD_API_BASE = originalApiBase;
    process.env.NEXT_PUBLIC_MONAD_DAEMON_PORT = originalPort;
    process.env.NEXT_PUBLIC_MONAD_DAEMON_SCHEME = originalScheme;
  }
});

test('resolveConnection keeps the browser loopback host for direct WebSocket control stream', () => {
  const originalWindow = globalThis.window;
  const originalLocalStorage = globalThis.localStorage;
  const originalApiBase = process.env.NEXT_PUBLIC_MONAD_API_BASE;
  const originalPort = process.env.NEXT_PUBLIC_MONAD_DAEMON_PORT;
  const originalScheme = process.env.NEXT_PUBLIC_MONAD_DAEMON_SCHEME;

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { hostname: 'localhost', origin: 'https://localhost:3000' } },
    writable: true
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null },
    writable: true
  });
  process.env.NEXT_PUBLIC_MONAD_API_BASE = '/api';
  process.env.NEXT_PUBLIC_MONAD_DAEMON_PORT = '52522';
  process.env.NEXT_PUBLIC_MONAD_DAEMON_SCHEME = 'https';

  try {
    expect(resolveConnection().wsBaseUrl).toBe('https://localhost:52522');
  } finally {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
      writable: true
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalLocalStorage,
      writable: true
    });
    process.env.NEXT_PUBLIC_MONAD_API_BASE = originalApiBase;
    process.env.NEXT_PUBLIC_MONAD_DAEMON_PORT = originalPort;
    process.env.NEXT_PUBLIC_MONAD_DAEMON_SCHEME = originalScheme;
  }
});
