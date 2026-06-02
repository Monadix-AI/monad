if (process.platform !== 'linux') process.exit(0);

import { afterEach, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { playwrightCacheDir } from '../../src/lib/browser-binary.ts';

const env = { ...Bun.env };

afterEach(() => {
  for (const key of ['PLAYWRIGHT_BROWSERS_PATH', 'XDG_CACHE_HOME']) {
    if (env[key] === undefined) delete Bun.env[key];
    else Bun.env[key] = env[key];
  }
});

test('playwrightCacheDir returns XDG-based path on Linux', () => {
  delete Bun.env.PLAYWRIGHT_BROWSERS_PATH;
  delete Bun.env.XDG_CACHE_HOME;
  expect(playwrightCacheDir()).toBe(join(homedir(), '.cache', 'ms-playwright'));
});

test('playwrightCacheDir honors XDG_CACHE_HOME on Linux', () => {
  delete Bun.env.PLAYWRIGHT_BROWSERS_PATH;
  Bun.env.XDG_CACHE_HOME = '/xdg/cache';
  expect(playwrightCacheDir()).toBe('/xdg/cache/ms-playwright');
});
