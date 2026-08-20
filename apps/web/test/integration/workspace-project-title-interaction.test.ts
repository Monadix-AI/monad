import { expect, test } from 'bun:test';

test('the app shell does not load a local development preview script', async () => {
  const html = await Bun.file(new URL('../../index.html', import.meta.url)).text();

  expect(html).not.toContain('localhost:8402');
  expect(html).not.toContain('impeccable-live');
});
