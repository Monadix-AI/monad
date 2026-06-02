import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import { getUsageResponseSchema, okResponseSchema } from '@monad/protocol';
import { Elysia } from 'elysia';

// HTTP-only surface: contract declared inline; reusable wire schemas come from @monad/protocol.
export function createUsageController(handlers: ReturnType<typeof createDaemonHandlers>) {
  return new Elysia({ tags: ['http-only'] })
    .get('/usage', async () => handlers.usage.get(), {
      response: { 200: getUsageResponseSchema },
      detail: { summary: 'Global usage ledger', description: 'Cumulative tokens + cost per provider/model.' }
    })
    .post('/usage/reset', async () => handlers.usage.reset(), {
      response: { 200: okResponseSchema },
      detail: { summary: 'Reset usage ledger', description: 'Wipes the global usage ledger (manual billing restart).' }
    });
}
