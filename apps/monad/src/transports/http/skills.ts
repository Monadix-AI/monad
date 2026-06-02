import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import {
  DEFAULT_SKILL_MARKETPLACE_SOURCE,
  daemonHttpContract,
  searchSkillsResponseSchema,
  skillDetailSchema,
  skillMarketplaceSourceSchema,
  skillSortModeSchema
} from '@monad/protocol';
import { Elysia } from 'elysia';
import { z } from 'zod';

export function createSkillsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const contract = daemonHttpContract.skills.list;
  return new Elysia()
    .get('/skills', async ({ query }) => handlers.skills.list(query), {
      query: contract.query,
      response: contract.response,
      detail: {
        summary: 'List discovered skills',
        description: 'Returns name/description/userInvocable for each skill found under ~/.monad/skills.'
      }
    })
    .get(
      '/skills/browse',
      async ({ query }) => handlers.skills.browse(query.sort, query.source ?? DEFAULT_SKILL_MARKETPLACE_SOURCE),
      {
        query: z.object({ sort: skillSortModeSchema, source: skillMarketplaceSourceSchema.optional() }),
        response: { 200: searchSkillsResponseSchema },
        detail: {
          tags: ['http-only'],
          summary: 'Browse skill marketplace',
          description: 'List skills by sort mode (trending | top | new) without a search query.'
        }
      }
    )
    .get(
      '/skills/search',
      async ({ query }) =>
        handlers.skills.search(
          query.q ?? '',
          query.sort ?? undefined,
          query.source ?? DEFAULT_SKILL_MARKETPLACE_SOURCE
        ),
      {
        query: z.object({
          q: z.string().optional(),
          sort: skillSortModeSchema.optional(),
          source: skillMarketplaceSourceSchema.optional()
        }),
        response: { 200: searchSkillsResponseSchema },
        detail: {
          tags: ['http-only'],
          summary: 'Search skill marketplace',
          description: 'Search the selected skill marketplace by query with optional sort (trending | top | new).'
        }
      }
    )
    .get(
      '/skills/:slug',
      async ({ params, query }) =>
        handlers.skills.detail(params.slug, query.source ?? DEFAULT_SKILL_MARKETPLACE_SOURCE),
      {
        query: z.object({ source: skillMarketplaceSourceSchema.optional() }),
        response: { 200: skillDetailSchema },
        detail: {
          tags: ['http-only'],
          summary: 'Fetch skill detail',
          description: 'Returns skill detail and install metadata.'
        }
      }
    );
}
