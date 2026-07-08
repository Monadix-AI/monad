import { afterEach, describe, expect, test } from 'bun:test';

import { navigateShellUrl, toShellUrl } from '../../hooks/use-shell-location';

const originalWindow = globalThis.window;

function installWindowMock(startUrl = 'http://localhost:3000/studio/runtime') {
  let current = new URL(startUrl);
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const calls: Array<{ mode: 'push' | 'replace'; url: string }> = [];
  const windowMock = {
    get location() {
      return current;
    },
    history: {
      pushState: (_state: unknown, _title: string, url?: string | URL | null) => {
        if (url) current = new URL(String(url), current.href);
        calls.push({ mode: 'push', url: `${current.pathname}${current.search}${current.hash}` });
      },
      replaceState: (_state: unknown, _title: string, url?: string | URL | null) => {
        if (url) current = new URL(String(url), current.href);
        calls.push({ mode: 'replace', url: `${current.pathname}${current.search}${current.hash}` });
      },
      state: { key: 'current' }
    },
    addEventListener: (type: string, listener: (event: Event) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: (event: Event) => void) => {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent: (event: Event) => {
      listeners.get(event.type)?.forEach((listener) => {
        listener(event);
      });
      return true;
    }
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: windowMock
  });
  return { calls, listeners };
}

afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow
  });
});

describe('shell location navigation', () => {
  test('normalizes same-origin URLs to path-only shell URLs', () => {
    installWindowMock();

    expect(toShellUrl('http://localhost:3000/studio/models?view=profiles#top')).toBe(
      '/studio/models?view=profiles#top'
    );
  });

  test('updates browser history and emits a shell location event without document navigation', () => {
    const { calls, listeners } = installWindowMock();
    let eventCount = 0;
    let popstateCount = 0;
    window.addEventListener('monad:shell-location', () => {
      eventCount += 1;
    });
    window.addEventListener('popstate', () => {
      popstateCount += 1;
    });

    navigateShellUrl('/workplace/projects/p1?view=members', 'replace');

    expect(calls).toEqual([{ mode: 'replace', url: '/workplace/projects/p1?view=members' }]);
    expect(eventCount).toBe(1);
    expect(popstateCount).toBe(1);
    expect(listeners.get('monad:shell-location')?.size).toBe(1);
  });

  test('skips no-op navigation to the current URL', () => {
    const { calls } = installWindowMock('http://localhost:3000/studio/runtime?view=overview');

    navigateShellUrl('/studio/runtime?view=overview', 'push');

    expect(calls).toEqual([]);
  });
});
