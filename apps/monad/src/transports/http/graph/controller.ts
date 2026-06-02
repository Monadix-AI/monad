import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

export function createGraphController(handlers: ReturnType<typeof createDaemonHandlers>) {
  return new Elysia().get('/graph', ({ query }) => handlers.graph.get(query), {
    query: daemonHttpContract.graph.get.query,
    response: daemonHttpContract.graph.get.response,
    detail: {
      summary: 'Read the L2 knowledge graph',
      description: 'Returns every entity node and current relation edge for the read-only graph viewer.'
    }
  });
}
