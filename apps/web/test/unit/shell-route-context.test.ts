import { expect, test } from 'bun:test';

test('shell route context identity survives split module reloads', async () => {
  const firstUrl = new URL('../../src/features/shell/page-shell/shell-route-context.tsx?hmr=first', import.meta.url);
  const secondUrl = new URL('../../src/features/shell/page-shell/shell-route-context.tsx?hmr=second', import.meta.url);
  const first = (await import(
    firstUrl.href
  )) as typeof import('../../src/features/shell/page-shell/shell-route-context');
  const second = (await import(
    secondUrl.href
  )) as typeof import('../../src/features/shell/page-shell/shell-route-context');

  expect(second.ShellRouteContext).toBe(first.ShellRouteContext);
});
