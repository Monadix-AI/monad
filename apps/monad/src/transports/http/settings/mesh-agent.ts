import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import {
  getMeshAgentResponseSchema,
  httpErrorSchema,
  listMeshAgentPresetsResponseSchema,
  listMeshAgentsResponseSchema,
  okResponseSchema,
  upsertMeshAgentRequestSchema
} from '@monad/protocol';
import { Elysia } from 'elysia';
import { z } from 'zod';

const agentParams = z.object({ name: z.string() });

export function createMeshAgentSettingsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  return new Elysia({ tags: ['http-only'] })
    .get('/mesh/agents', async () => handlers.meshAgentSettings.listMeshAgents(), {
      response: { 200: listMeshAgentsResponseSchema },
      detail: { summary: 'List MeshAgents' }
    })
    .get('/mesh/agents/presets', () => handlers.meshAgentSettings.listMeshAgentPresets(), {
      response: { 200: listMeshAgentPresetsResponseSchema },
      detail: { summary: 'List MeshAgent presets' }
    })
    .get('/mesh/agents/:name', async ({ params }) => handlers.meshAgentSettings.getMeshAgent(params), {
      params: agentParams,
      response: { 200: getMeshAgentResponseSchema, 404: httpErrorSchema },
      detail: { summary: 'Get MeshAgent', description: 'Returns one configured agent by name.' }
    })
    .put('/mesh/agents/:name', async ({ body }) => handlers.meshAgentSettings.upsertMeshAgent(body), {
      params: agentParams,
      body: upsertMeshAgentRequestSchema,
      response: { 200: okResponseSchema },
      detail: { summary: 'Upsert MeshAgent' }
    })
    .post(
      '/mesh/agents/:name/enable',
      async ({ params }) => handlers.meshAgentSettings.setMeshAgentEnabled({ name: params.name, enabled: true }),
      {
        params: agentParams,
        response: { 200: okResponseSchema, 404: httpErrorSchema },
        detail: { summary: 'Enable MeshAgent' }
      }
    )
    .post(
      '/mesh/agents/:name/disable',
      async ({ params }) => handlers.meshAgentSettings.setMeshAgentEnabled({ name: params.name, enabled: false }),
      {
        params: agentParams,
        response: { 200: okResponseSchema, 404: httpErrorSchema },
        detail: { summary: 'Disable MeshAgent' }
      }
    )
    .delete(
      '/mesh/agents/:name',
      async ({ params }) => handlers.meshAgentSettings.removeMeshAgent({ name: params.name }),
      {
        params: agentParams,
        response: { 200: okResponseSchema, 404: httpErrorSchema },
        detail: { summary: 'Remove MeshAgent' }
      }
    );
}
