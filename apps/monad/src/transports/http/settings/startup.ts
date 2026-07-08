import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

export function createStartupSettingsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const c = daemonHttpContract.startupSettings;

  return new Elysia({ tags: ['http-only'] })
    .get('/startup', async () => handlers.startup.getStartupSettings(), {
      response: c.get.response,
      detail: { summary: 'Get OS startup settings' }
    })
    .put('/startup', async ({ body }) => handlers.startup.setStartupSettings(body), {
      body: c.set.body,
      response: c.set.response,
      detail: { summary: 'Update OS startup settings' }
    });
}
