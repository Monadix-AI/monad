import { expect, test } from 'bun:test';

import { buildNativeCliServerUrl } from '@/bootstrap/native-cli-url.ts';

const remoteAccess = {
  allowedOrigins: [],
  token: ''
};

test('native CLI server URL uses HTTP when remote access is disabled', () => {
  expect(
    buildNativeCliServerUrl({
      port: 52522,
      remoteAccess: { ...remoteAccess, enabled: false, allowInsecureHttp: false }
    })
  ).toBe('http://127.0.0.1:52522');
});

test('native CLI server URL uses HTTPS when remote access TLS is required', () => {
  expect(
    buildNativeCliServerUrl({
      port: 52522,
      remoteAccess: { ...remoteAccess, enabled: true, allowInsecureHttp: false }
    })
  ).toBe('https://127.0.0.1:52522');
});

test('native CLI server URL keeps HTTP when remote access allows insecure HTTP', () => {
  expect(
    buildNativeCliServerUrl({
      port: 52522,
      remoteAccess: { ...remoteAccess, enabled: true, allowInsecureHttp: true }
    })
  ).toBe('http://127.0.0.1:52522');
});
