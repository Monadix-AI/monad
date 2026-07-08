import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

export function createAppearanceSettingsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const c = daemonHttpContract.appearanceSettings;

  return new Elysia({ tags: ['http-only'] })
    .get('/appearance', async () => handlers.appearance.getAppearanceSettings(), {
      response: c.get.response,
      detail: { summary: 'Get app-wide appearance settings' }
    })
    .put('/appearance', async ({ body }) => handlers.appearance.setAppearanceSettings(body), {
      body: c.set.body,
      response: c.set.response,
      detail: { summary: 'Update app-wide appearance settings' }
    });
}
