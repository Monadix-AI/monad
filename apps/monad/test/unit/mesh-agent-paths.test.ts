import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { meshFixtureCaptureDirectory } from '#/services/mesh-agent/fixture-paths.ts';

test('live event captures are stored with daemon logs', () => {
  expect(
    meshFixtureCaptureDirectory({
      logs: '/var/monad/logs'
    })
  ).toBe(join('/var/monad/logs', 'mesh-agent-fixture-capture'));
});
