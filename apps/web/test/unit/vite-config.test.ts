import { expect, test } from 'bun:test';

test('vite config provides the web dev server contract', async () => {
  const { default: config } = await import('../../vite.config.ts');
  const resolved = typeof config === 'function' ? await config({ command: 'serve', mode: 'development' }) : config;

  expect(resolved.build?.outDir).toBe('out');
  expect(resolved.server?.hmr).toEqual({ overlay: true });
  expect(Object.keys(resolved.server?.proxy ?? {}).sort()).toEqual(['/api', '/v1']);
});
