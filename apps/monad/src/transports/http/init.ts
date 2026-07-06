import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import {
  envDepsStatusResponseSchema,
  getInitStatusResponseSchema,
  httpErrorSchema,
  installEnvDepsRequestSchema,
  installEnvDepsResponseSchema,
  okResponseSchema,
  setInitHomeRequestSchema
} from '@monad/protocol';
import { Elysia } from 'elysia';

import { HandlerError } from '@/handlers/handler-error.ts';

// HTTP-only surface: contract declared inline; reusable wire schemas come from @monad/protocol.
export function createInitController(handlers: ReturnType<typeof createDaemonHandlers>) {
  return new Elysia({ tags: ['http-only'] })
    .get('/init/status', async () => handlers.init.status(), {
      response: { 200: getInitStatusResponseSchema },
      detail: { summary: 'Init status', description: 'Returns whether monad has been initialized.' }
    })
    .post(
      '/init/home',
      async ({ body, status }) => {
        try {
          return await handlers.init.setHome(body.path);
        } catch (e) {
          if (e instanceof HandlerError && e.kind === 'conflict') {
            return status(409, { error: e.message });
          }
          throw e;
        }
      },
      {
        body: setInitHomeRequestSchema,
        response: { 200: okResponseSchema, 409: httpErrorSchema },
        detail: { summary: 'Set home directory', description: 'Change monad home and trigger daemon restart.' }
      }
    )
    .get('/init/env-deps', async () => handlers.init.envDepsStatus(), {
      response: { 200: envDepsStatusResponseSchema },
      detail: { summary: 'Env deps status', description: 'Check whether node and uv are available.' }
    })
    .post('/init/env-deps', async ({ body }) => handlers.init.installEnvDepsHandler(body), {
      body: installEnvDepsRequestSchema,
      response: { 200: installEnvDepsResponseSchema },
      detail: { summary: 'Install env deps', description: 'Download and install node/uv to ~/.monad/bin.' }
    });
}
