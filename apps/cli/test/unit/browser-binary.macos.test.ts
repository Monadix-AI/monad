if (process.platform !== 'darwin') process.exit(0);

import { afterEach, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { playwrightCacheDir } from '../../src/lib/browser-binary.ts';

const env = { ...Bun.env };

afterEach(() => {
  for (const key of ['PLAYWRIGHT_BROWSERS_PATH']) {
    if (env[key] === undefined) delete Bun.env[key];
    else Bun.env[key] = env[key];
  }
});

test('playwrightCacheDir returns ~/Library/Caches/ms-playwright on macOS', () => {
  delete Bun.env.PLAYWRIGHT_BROWSERS_PATH;
  expect(playwrightCacheDir()).toBe(join(homedir(), 'Library', 'Caches', 'ms-playwright'));
});
