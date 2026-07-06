import type { createDaemonHandlers } from '@/handlers/daemon-handlers/index.ts';

import { indexerStatusSchema } from '@monad/protocol';
import { Elysia } from 'elysia';

// HTTP-only surface: contract declared inline. `indexerStatusSchema` is a reusable wire type
// (also consumed by the web client), so it stays in @monad/protocol.
export function createIndexerController(handlers: ReturnType<typeof createDaemonHandlers>) {
  return new Elysia({ tags: ['http-only'] }).get('/indexer/status', async () => handlers.indexer.status(), {
    response: { 200: indexerStatusSchema },
    detail: {
      summary: 'Indexer status',
      description: 'Returns the number of messages pending embedding and whether the indexer is currently running.'
    }
  });
}
