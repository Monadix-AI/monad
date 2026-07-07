import { expect, test } from 'bun:test';

import { buildNativeCliServerUrl } from '@/bootstrap/native-cli-url.ts';

test('native CLI server URL uses HTTPS by default', () => {
  expect(
    buildNativeCliServerUrl({
      port: 52522,
      https: { enabled: true }
    })
  ).toBe('https://127.0.0.1:52522');
});

test('native CLI server URL uses HTTP only when HTTPS is disabled', () => {
  expect(
    buildNativeCliServerUrl({
      port: 52522,
      https: { enabled: false }
    })
  ).toBe('http://127.0.0.1:52522');
});
