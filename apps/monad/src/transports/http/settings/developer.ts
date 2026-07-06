import type { createDaemonHandlers } from '@/handlers/daemon-handlers/index.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

export function createDeveloperSettingsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const c = daemonHttpContract.developerSettings;

  return new Elysia({ tags: ['http-only'] })
    .get('/developer', async () => handlers.developer.getDeveloperSettings(), {
      response: c.get.response,
      detail: { summary: 'Get developer logging settings' }
    })
    .put('/developer', async ({ body }) => handlers.developer.setDeveloperSettings(body), {
      body: c.set.body,
      response: c.set.response,
      detail: { summary: 'Update developer logging settings' }
    });
}
