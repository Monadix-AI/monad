import { expect, test } from 'bun:test';

test('Monad runtime context keeps its identity across module reloads', async () => {
  const moduleUrl = new URL('../../src/lib/monad-runtime-context.ts', import.meta.url);
  const first = await import(`${moduleUrl.href}?hmr=first`);
  const second = await import(`${moduleUrl.href}?hmr=second`);

  expect(first.MonadRuntimeContext).toBe(second.MonadRuntimeContext);
});
