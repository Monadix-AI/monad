import { afterEach, expect, test } from 'bun:test';

import { ensureBrowserBinary, hasChromium, playwrightCacheDir } from '../../src/lib/browser-binary.ts';

const env = { ...Bun.env };
afterEach(() => {
  if (env.PLAYWRIGHT_BROWSERS_PATH === undefined) delete Bun.env.PLAYWRIGHT_BROWSERS_PATH;
  else Bun.env.PLAYWRIGHT_BROWSERS_PATH = env.PLAYWRIGHT_BROWSERS_PATH;
});

test('playwrightCacheDir resolves to an ms-playwright path', () => {
  delete Bun.env.PLAYWRIGHT_BROWSERS_PATH;
  expect(playwrightCacheDir().endsWith('ms-playwright')).toBe(true);
});

test('playwrightCacheDir honors PLAYWRIGHT_BROWSERS_PATH', () => {
  Bun.env.PLAYWRIGHT_BROWSERS_PATH = '/custom/pw';
  expect(playwrightCacheDir()).toBe('/custom/pw');
});

test('hasChromium is false for an empty/missing cache dir', () => {
  Bun.env.PLAYWRIGHT_BROWSERS_PATH = '/no/such/playwright/dir';
  expect(hasChromium()).toBe(false);
});

test('ensureBrowserBinary skips the install when the user declines (no browser present)', async () => {
  Bun.env.PLAYWRIGHT_BROWSERS_PATH = '/no/such/playwright/dir';
  // Decline → returns without throwing; never reaches the installer.
  await ensureBrowserBinary(async () => 'n');
  expect(true).toBe(true);
});
