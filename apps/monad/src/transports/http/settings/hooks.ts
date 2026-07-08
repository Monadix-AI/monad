import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

export function createHooksSettingsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const c = daemonHttpContract.hooksSettings;

  return new Elysia({ tags: ['http-only'] })
    .get('/hooks', async () => handlers.hooks.getHooks(), {
      response: c.get.response,
      detail: { summary: 'Get lifecycle hook configuration' }
    })
    .put('/hooks', async ({ body }) => handlers.hooks.setHooks(body), {
      body: c.set.body,
      response: c.set.response,
      detail: { summary: 'Update lifecycle hook configuration' }
    });
}
