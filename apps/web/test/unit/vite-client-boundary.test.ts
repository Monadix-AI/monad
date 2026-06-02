import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('../../', import.meta.url));

test('the Vite app does not carry React Server Component directives', async () => {
  const directives: string[] = [];
  const files = new Bun.Glob('src/**/*.{js,jsx,ts,tsx}');

  for await (const path of files.scan({ cwd: webRoot, onlyFiles: true })) {
    const source = readFileSync(`${webRoot}/${path}`, 'utf8');
    if (/^\s*['"]use (?:client|server)['"];?/m.test(source)) directives.push(path);
  }

  expect(directives).toEqual([]);
});

test('the component generator targets the Vite client runtime', () => {
  const config = JSON.parse(readFileSync(`${webRoot}/components.json`, 'utf8')) as { rsc?: boolean };

  expect(config.rsc).toBe(false);
});
