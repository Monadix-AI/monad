import { expect, test } from 'bun:test';

import { daemonApiUrl, resolveConnection } from '../../src/lib/monad-store.ts';

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

test('resolveConnection uses the Vite proxy path in development', () => {
  const originalWindow = globalThis.window;
  const originalLocalStorage = globalThis.localStorage;
  const originalNodeEnv = process.env.NODE_ENV;

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
  process.env.NODE_ENV = 'development';

  try {
    expect(resolveConnection()).toEqual({
      baseUrl: 'https://127.0.0.1:3000/api'
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
    process.env.NODE_ENV = originalNodeEnv;
  }
});

test('resolveConnection uses same-origin daemon API outside development', () => {
  const originalWindow = globalThis.window;
  const originalLocalStorage = globalThis.localStorage;
  const originalNodeEnv = process.env.NODE_ENV;

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'https://localhost:52749' } },
    writable: true
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null },
    writable: true
  });
  process.env.NODE_ENV = 'production';

  try {
    expect(resolveConnection()).toEqual({ baseUrl: 'https://localhost:52749' });
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
    process.env.NODE_ENV = originalNodeEnv;
  }
});

test('daemonApiUrl appends daemon paths to development and release base URLs', () => {
  expect(daemonApiUrl('https://127.0.0.1:3000/api', '/v1/sessions')).toBe('https://127.0.0.1:3000/api/v1/sessions');
  expect(daemonApiUrl('https://127.0.0.1:52749', '/v1/sessions')).toBe('https://127.0.0.1:52749/v1/sessions');
  expect(daemonApiUrl('https://127.0.0.1:52749/', '/health')).toBe('https://127.0.0.1:52749/health');
});
