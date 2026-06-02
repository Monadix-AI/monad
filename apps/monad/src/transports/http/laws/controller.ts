import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

export function createLawsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  return new Elysia().get('/memory/laws', ({ query }) => handlers.laws.get(query), {
    query: daemonHttpContract.laws.get.query,
    response: daemonHttpContract.laws.get.response,
    detail: {
      summary: 'Read the L3 inferred laws',
      description: 'All inferred laws across scopes (statement, confidence, support), for the read-only Memory panel.'
    }
  });
}
