import { describe, expect, test } from 'bun:test';

import { shouldRedirectInitToHome } from '../../lib/init-redirect.ts';

// The /init route is canonical and stays reachable after initialization.
describe('shouldRedirectInitToHome', () => {
  test('dev: stays on /init even when already initialized', () => {
    expect(shouldRedirectInitToHome(true, true)).toBe(false);
  });

  test('dev: stays on /init when not initialized', () => {
    expect(shouldRedirectInitToHome(false, true)).toBe(false);
  });

  test('release: stays on /init even when already initialized', () => {
    expect(shouldRedirectInitToHome(true, false)).toBe(false);
  });

  test('release: stays on /init when not initialized', () => {
    expect(shouldRedirectInitToHome(false, false)).toBe(false);
  });
});
