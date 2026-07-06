import type { createDaemonHandlers } from '@/handlers/daemon-handlers/index.ts';

import { getStatsResponseSchema, statsRangeSchema } from '@monad/protocol';
import { Elysia } from 'elysia';
import { z } from 'zod';

// HTTP-only surface: contract declared inline; reusable wire schemas come from @monad/protocol.
export function createStatsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  return new Elysia({ tags: ['http-only'] }).get('/stats', async ({ query }) => handlers.stats.get(query.range), {
    query: z.object({ range: statsRangeSchema.optional().default('all') }),
    response: { 200: getStatsResponseSchema },
    detail: {
      summary: 'Dashboard stats',
      description: 'Pre-aggregated overview + model breakdown for the stats dashboard.'
    }
  });
}
