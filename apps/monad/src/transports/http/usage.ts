import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import { getUsageResponseSchema, okResponseSchema } from '@monad/protocol';
import { Elysia } from 'elysia';
import { z } from 'zod';

// HTTP query strings arrive untyped, so limit/offset need z.coerce here even though
// getUsageQuerySchema (== offsetPaginationQuerySchema) itself takes typed numbers for RPC callers.
const getUsageHttpQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().nonnegative().optional()
});

// HTTP-only surface: contract declared inline; reusable wire schemas come from @monad/protocol.
export function createUsageController(handlers: ReturnType<typeof createDaemonHandlers>) {
  return new Elysia({ tags: ['http-only'] })
    .get('/usage', async ({ query }) => handlers.usage.get(query), {
      query: getUsageHttpQuerySchema,
      response: { 200: getUsageResponseSchema },
      detail: { summary: 'Global usage ledger', description: 'Cumulative tokens + cost per provider/model.' }
    })
    .post('/usage/reset', async () => handlers.usage.reset(), {
      response: { 200: okResponseSchema },
      detail: { summary: 'Reset usage ledger', description: 'Wipes the global usage ledger (manual billing restart).' }
    });
}
