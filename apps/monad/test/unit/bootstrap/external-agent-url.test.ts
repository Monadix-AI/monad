import { expect, test } from 'bun:test';

import { buildExternalAgentServerUrl } from '@/bootstrap/external-agent-url.ts';

test('external agent server URL uses HTTPS by default', () => {
  expect(
    buildExternalAgentServerUrl({
      port: 52522,
      https: { enabled: true }
    })
  ).toBe('https://127.0.0.1:52522');
});

test('external agent server URL uses HTTP only when HTTPS is disabled', () => {
  expect(
    buildExternalAgentServerUrl({
      port: 52522,
      https: { enabled: false }
    })
  ).toBe('http://127.0.0.1:52522');
});
