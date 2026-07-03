import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

export function createBrowserPresetSettingsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const c = daemonHttpContract.browserPresetSettings;

  return new Elysia({ tags: ['http-only'] })
    .get('/browser-preset', async () => handlers.browserPreset.getBrowserPreset(), {
      response: c.get.response,
      detail: { summary: 'Get browser (Playwright) preset config' }
    })
    .put('/browser-preset', async ({ body }) => handlers.browserPreset.setBrowserPreset(body), {
      body: c.set.body,
      response: c.set.response,
      detail: { summary: 'Update browser (Playwright) preset config' }
    });
}
