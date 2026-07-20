import { expect, test } from 'bun:test';

import { meshFixtureCaptureDirectory } from '#/handlers/daemon-handlers/mesh-agent-paths.ts';

test('live event captures are stored with daemon logs', () => {
  expect(
    meshFixtureCaptureDirectory({
      logs: '/var/monad/logs'
    })
  ).toBe('/var/monad/logs/mesh-agent-fixture-capture');
});
