import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

export function createMem0DataController(handlers: ReturnType<typeof createDaemonHandlers>) {
  return new Elysia().get('/memory/mem0', () => handlers.mem0Data.get(), {
    response: daemonHttpContract.mem0Data.get.response,
    detail: {
      tags: ['http-only'],
      summary: 'Read the mem0 explorer view',
      description: 'Stored mem0 memories with a 2D embedding projection, per-scope counts, and vector-store status.'
    }
  });
}
