import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

export function createClarifyController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const contract = daemonHttpContract.clarify.respond;
  return new Elysia().post('/clarifications/respond', async ({ body }) => handlers.clarify.respond(body), {
    body: contract.body,
    response: contract.response,
    detail: {
      summary: 'Answer a pending clarify question',
      description: 'Resolves a pending clarify.requested with the user reply. ok:false → unknown/expired request id.'
    }
  });
}
