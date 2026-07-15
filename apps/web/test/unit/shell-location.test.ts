import { afterEach, describe, expect, test } from 'bun:test';

import { navigateShellUrl, setShellRouter, toShellUrl } from '../../src/hooks/use-shell-location';

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

function installShellRouterMock(startUrl = '/studio/runtime') {
  const calls: Array<{ mode: 'push' | 'replace'; url: string }> = [];
  const router = {
    history: {
      push: (url: string) => {
        router.state.location.href = url;
        calls.push({ mode: 'push', url });
      },
      replace: (url: string) => {
        router.state.location.href = url;
        calls.push({ mode: 'replace', url });
      }
    },
    state: {
      location: {
        href: startUrl
      }
    }
  };
  setShellRouter(router as never);
  return { calls };
}

afterEach(() => {
  setShellRouter(null);
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

  test('routes shell navigation through TanStack history', () => {
    installWindowMock();
    const { calls } = installShellRouterMock();

    navigateShellUrl('/workspace/prj_ABCDEF123456/ses_UVWXYZ789012?view=members', 'replace');

    expect(calls).toEqual([{ mode: 'replace', url: '/workspace/prj_ABCDEF123456/ses_UVWXYZ789012?view=members' }]);
  });

  test('skips no-op navigation to the current URL', () => {
    installWindowMock('http://localhost:3000/studio/runtime?view=overview');
    const { calls } = installShellRouterMock('/studio/runtime?view=overview');

    navigateShellUrl('/studio/runtime?view=overview', 'push');

    expect(calls).toEqual([]);
  });

  test('consuming a reached message deep link re-enables transcript follow mode', async () => {
    installWindowMock('http://localhost:3000/sessions/ses_ABCDEF123456?msg=msg_ABCDEF123456&panel=inspector#details');
    const { calls } = installShellRouterMock('/sessions/ses_ABCDEF123456?msg=msg_ABCDEF123456&panel=inspector#details');
    const shellLocation = await import('../../src/hooks/use-shell-location');
    const removeShellSearchParam = Reflect.get(shellLocation, 'removeShellSearchParam') as
      | ((param: string) => void)
      | undefined;

    expect(removeShellSearchParam).toBeFunction();
    if (!removeShellSearchParam) return;

    removeShellSearchParam('msg');

    expect(calls).toEqual([
      {
        mode: 'replace',
        url: '/sessions/ses_ABCDEF123456?panel=inspector#details'
      }
    ]);
    const consumedUrl = calls[0]?.url;
    expect(consumedUrl).toBeDefined();
    if (!consumedUrl) return;
    const consumedRoute = new URL(consumedUrl, 'http://localhost:3000');
    expect(consumedRoute.searchParams.get('msg')).toBeNull();
    expect(consumedRoute.searchParams.get('panel')).toBe('inspector');
    expect(consumedRoute.hash).toBe('#details');
  });

  test('a stale message scroll callback does not consume a newer deep link', async () => {
    installWindowMock('http://localhost:3000/sessions/ses_NEW?msg=msg_NEW');
    const { calls } = installShellRouterMock('/sessions/ses_NEW?msg=msg_NEW');
    const { removeShellSearchParam } = await import('../../src/hooks/use-shell-location');

    removeShellSearchParam('msg', 'msg_OLD');

    expect(calls).toEqual([]);
  });
});
