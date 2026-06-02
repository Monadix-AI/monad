import { describe, expect, test } from 'bun:test';

import { shouldRedirectInitToHome } from '../../lib/init-redirect.ts';

// The /init route policy: dev keeps the wizard reachable after initialization,
// release auto-redirects a completed setup back to home.
describe('shouldRedirectInitToHome', () => {
  test('dev: stays on /init even when already initialized', () => {
    expect(shouldRedirectInitToHome(true, true)).toBe(false);
  });

  test('dev: stays on /init when not initialized', () => {
    expect(shouldRedirectInitToHome(false, true)).toBe(false);
  });

  test('release: redirects to home when already initialized', () => {
    expect(shouldRedirectInitToHome(true, false)).toBe(true);
  });

  test('release: stays on /init when not initialized', () => {
    expect(shouldRedirectInitToHome(false, false)).toBe(false);
  });
});
