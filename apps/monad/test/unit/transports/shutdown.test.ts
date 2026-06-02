import { expect, test } from 'bun:test';

import { createDaemonShutdown } from '#/transports/shutdown.ts';

test('daemon shutdown releases dependents before the runtime kernel', async () => {
  const events: string[] = [];
  const shutdown = createDaemonShutdown({
    schedule: { dispose: () => events.push('schedule') },
    watchers: { closeAll: () => events.push('watchers') },
    channels: { stop: async () => void events.push('channels') },
    meshAgents: { stopAll: () => void events.push('meshAgents') },
    runtime: { stop: async () => void events.push('runtime') }
  });

  await shutdown();

  // meshAgents.stopAll() persists exit state for each live mesh session, so it must run before
  // runtime.stop() closes the store's DB connection — this ordering is the fix for the
  // "Cannot use a closed database" shutdown error mesh sessions used to hit.
  expect(events).toEqual(['schedule', 'watchers', 'channels', 'meshAgents', 'runtime']);
});

test('daemon shutdown coalesces concurrent signal handlers', async () => {
  let stops = 0;
  const shutdown = createDaemonShutdown({
    schedule: { dispose: () => {} },
    watchers: { closeAll: () => {} },
    channels: { stop: async () => {} },
    meshAgents: { stopAll: () => {} },
    runtime: {
      stop: async () => {
        stops += 1;
      }
    }
  });

  await Promise.all([shutdown(), shutdown()]);

  expect(stops).toBe(1);
});
