import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

export function createComputerPresetSettingsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const c = daemonHttpContract.computerPresetSettings;

  return new Elysia({ tags: ['http-only'] })
    .get('/computer-preset', async () => handlers.computerPreset.getComputerPreset(), {
      response: c.get.response,
      detail: { summary: 'Get computer-use preset config' }
    })
    .put('/computer-preset', async ({ body }) => handlers.computerPreset.setComputerPreset(body), {
      body: c.set.body,
      response: c.set.response,
      detail: { summary: 'Update computer-use preset config' }
    });
}
