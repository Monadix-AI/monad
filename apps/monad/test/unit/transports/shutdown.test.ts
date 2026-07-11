import { expect, test } from 'bun:test';

import { createDaemonShutdown } from '#/transports/shutdown.ts';

test('daemon shutdown releases dependents before the runtime kernel', async () => {
  const events: string[] = [];
  const shutdown = createDaemonShutdown({
    schedule: { dispose: () => events.push('schedule') },
    watchers: { closeAll: () => events.push('watchers') },
    channels: { stop: async () => void events.push('channels') },
    runtime: { stop: async () => void events.push('runtime') }
  });

  await shutdown();

  expect(events).toEqual(['schedule', 'watchers', 'channels', 'runtime']);
});

test('daemon shutdown coalesces concurrent signal handlers', async () => {
  let stops = 0;
  const shutdown = createDaemonShutdown({
    schedule: { dispose: () => {} },
    watchers: { closeAll: () => {} },
    channels: { stop: async () => {} },
    runtime: {
      stop: async () => {
        stops += 1;
      }
    }
  });

  await Promise.all([shutdown(), shutdown()]);

  expect(stops).toBe(1);
});
