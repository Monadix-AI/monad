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
