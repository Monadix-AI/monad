import type { createDaemonHandlers } from '@/handlers/daemon-handlers/index.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

export function createOpenaiCompatSettingsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const c = daemonHttpContract.openaiCompatSettings;

  return new Elysia({ tags: ['http-only'] })
    .get('/openai-compat', async () => handlers.openaiCompat.getOpenaiCompat(), {
      response: c.get.response,
      detail: {
        summary: 'Get OpenAI-compatible API settings',
        description: 'Returns whether the OpenAI-compatible API endpoint is enabled and its auth token configuration.'
      }
    })
    .put('/openai-compat', async ({ body }) => handlers.openaiCompat.setOpenaiCompat(body), {
      body: c.set.body,
      response: c.set.response,
      detail: {
        summary: 'Update OpenAI-compatible API settings',
        description: 'Enable or disable the OpenAI-compatible API endpoint and configure its bearer token.'
      }
    });
}
