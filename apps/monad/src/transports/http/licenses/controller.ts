import type { createDaemonHandlers } from '@/handlers/daemon-handlers/index.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

export function createLicensesController(handlers: ReturnType<typeof createDaemonHandlers>) {
  return new Elysia().get('/licenses', async () => handlers.licenses.list(), {
    response: daemonHttpContract.licenses.list.response,
    detail: {
      tags: ['http-only'],
      summary: 'List third-party package licenses',
      description: 'Returns name, version, license type, and homepage for every third-party package bundled with monad.'
    }
  });
}
