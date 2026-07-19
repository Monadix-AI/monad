import { expect, test } from 'bun:test';

import { isExpectedSchemeDisconnect, schemeTargetUrl } from '../../src/features/settings/network-scheme-transition.ts';

test('schemeTargetUrl preserves the page while changing protocol and daemon endpoint', () => {
  expect(
    schemeTargetUrl('https://127.0.0.1:52749/settings/connection?tab=network', {
      enabled: false,
      host: '0.0.0.0',
      port: 52749
    })
  ).toBe('http://127.0.0.1:52749/settings/connection?tab=network');
});

test('only HTTP transition fetch disconnects are treated as expected listener replacement', () => {
  const disconnect = { error: 'TypeError: Load failed', status: 'FETCH_ERROR' };
  expect(isExpectedSchemeDisconnect(false, disconnect)).toBe(true);
  expect(isExpectedSchemeDisconnect(false, { error: {}, status: 'CUSTOM_ERROR' })).toBe(true);
  expect(isExpectedSchemeDisconnect(false, { message: 'Failed to fetch' })).toBe(true);
  expect(isExpectedSchemeDisconnect(false, { message: 'request failed', status: 0 })).toBe(true);
  expect(
    isExpectedSchemeDisconnect(false, {
      message: 'Failed to fetch',
      raw: { message: 'Failed to fetch', name: 'TypeError' },
      status: 503
    })
  ).toBe(true);
  expect(isExpectedSchemeDisconnect(true, disconnect)).toBe(false);
  expect(isExpectedSchemeDisconnect(false, { error: 'validation failed', status: 400 })).toBe(false);
  expect(isExpectedSchemeDisconnect(false, { message: 'service unavailable', status: 503 })).toBe(false);
});
