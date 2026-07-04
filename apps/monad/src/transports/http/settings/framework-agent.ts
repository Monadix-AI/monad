import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import {
  listFrameworkAgentsResponseSchema,
  okResponseSchema,
  upsertFrameworkAgentRequestSchema
} from '@monad/protocol';
import { Elysia } from 'elysia';
import { z } from 'zod';

const agentParams = z.object({ name: z.string() });

export function createFrameworkAgentSettingsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  return new Elysia({ tags: ['http-only'] })
    .get('/framework-agents', async () => handlers.frameworkAgent.listFrameworkAgents(), {
      response: { 200: listFrameworkAgentsResponseSchema },
      detail: { summary: 'List framework agents' }
    })
    .put('/framework-agents', async ({ body }) => handlers.frameworkAgent.upsertFrameworkAgent(body), {
      body: upsertFrameworkAgentRequestSchema,
      response: { 200: okResponseSchema },
      detail: { summary: 'Upsert framework agent' }
    })
    .post(
      '/framework-agents/:name/enable',
      async ({ params }) => handlers.frameworkAgent.setFrameworkAgentEnabled({ name: params.name, enabled: true }),
      { params: agentParams, response: { 200: okResponseSchema }, detail: { summary: 'Enable framework agent' } }
    )
    .post(
      '/framework-agents/:name/disable',
      async ({ params }) => handlers.frameworkAgent.setFrameworkAgentEnabled({ name: params.name, enabled: false }),
      { params: agentParams, response: { 200: okResponseSchema }, detail: { summary: 'Disable framework agent' } }
    )
    .delete(
      '/framework-agents/:name',
      async ({ params }) => handlers.frameworkAgent.removeFrameworkAgent({ name: params.name }),
      {
        params: agentParams,
        response: { 200: okResponseSchema },
        detail: { summary: 'Remove framework agent' }
      }
    );
}
