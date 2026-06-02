import { expect, test } from 'bun:test';

import { acquireTaskSlot, mcpTaskRuntimeSnapshot } from '#/capabilities/tools/registry/mcp/task-runtime';

test('MCP Task admission bounds active work and releases queued work in order', async () => {
  const server = 'runtime-test';
  const releases = await Promise.all(Array.from({ length: 8 }, () => acquireTaskSlot(server)));
  let ninthEntered = false;
  const ninth = acquireTaskSlot(server).then((release) => {
    ninthEntered = true;
    return release;
  });
  await Promise.resolve();

  expect({ ninthEntered, stats: mcpTaskRuntimeSnapshot()[server] }).toEqual({
    ninthEntered: false,
    stats: {
      active: 8,
      cancelled: 0,
      completed: 0,
      failed: 0,
      pendingDeliveries: 0,
      queued: 1,
      recovered: 0,
      retries: 0,
      started: 8,
      totalDurationMs: 0
    }
  });

  releases.shift()?.();
  const releaseNinth = await ninth;
  expect({ ninthEntered, active: mcpTaskRuntimeSnapshot()[server]?.active }).toEqual({
    ninthEntered: true,
    active: 8
  });
  for (const release of releases) release();
  releaseNinth();
});
