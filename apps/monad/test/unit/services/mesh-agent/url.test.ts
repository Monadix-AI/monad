import { expect, test } from 'bun:test';

import { buildMeshAgentServerUrl } from '#/services/mesh-agent/url.ts';

test('MeshAgent server URL uses HTTPS by default', () => {
  expect(
    buildMeshAgentServerUrl({
      port: 52522,
      https: { enabled: true }
    })
  ).toBe('https://127.0.0.1:52522');
});

test('MeshAgent server URL uses HTTP only when HTTPS is disabled', () => {
  expect(
    buildMeshAgentServerUrl({
      port: 52522,
      https: { enabled: false }
    })
  ).toBe('http://127.0.0.1:52522');
});
