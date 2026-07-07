import type { createDaemonHandlers } from '@/handlers/daemon-handlers/index.ts';

import {
  externalAgentSettingsImportApplyRequestSchema,
  externalAgentSettingsImportApplyResultSchema,
  externalAgentSettingsImportPreviewRequestSchema,
  externalAgentSettingsImportPreviewSchema,
  getExternalAgentResponseSchema,
  httpErrorSchema,
  listExternalAgentPresetsResponseSchema,
  listExternalAgentSettingsImportCandidatesResponseSchema,
  listExternalAgentsResponseSchema,
  okResponseSchema,
  upsertExternalAgentRequestSchema
} from '@monad/protocol';
import { Elysia } from 'elysia';
import { z } from 'zod';

const agentParams = z.object({ name: z.string() });

export function createExternalAgentSettingsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  return new Elysia({ tags: ['http-only'] })
    .get('/external-agents', async () => handlers.externalAgentSettings.listExternalAgents(), {
      response: { 200: listExternalAgentsResponseSchema },
      detail: { summary: 'List external agents' }
    })
    .get('/external-agents/presets', () => handlers.externalAgentSettings.listExternalAgentPresets(), {
      response: { 200: listExternalAgentPresetsResponseSchema },
      detail: { summary: 'List external agent presets' }
    })
    .get('/external-agents/:name', async ({ params }) => handlers.externalAgentSettings.getExternalAgent(params), {
      params: agentParams,
      response: { 200: getExternalAgentResponseSchema, 404: httpErrorSchema },
      detail: { summary: 'Get external agent', description: 'Returns one configured agent by name.' }
    })
    .get(
      '/external-agents/:name/import/candidates',
      ({ params }) => handlers.externalAgentSettings.listExternalAgentSettingsImportCandidates({ name: params.name }),
      {
        params: agentParams,
        response: { 200: listExternalAgentSettingsImportCandidatesResponseSchema },
        detail: { summary: 'List external agent settings import candidates' }
      }
    )
    .post(
      '/external-agents/:name/import/preview',
      ({ params, body }) =>
        handlers.externalAgentSettings.previewExternalAgentSettingsImport({ name: params.name, request: body }),
      {
        params: agentParams,
        body: externalAgentSettingsImportPreviewRequestSchema,
        response: { 200: externalAgentSettingsImportPreviewSchema },
        detail: { summary: 'Preview external agent settings import' }
      }
    )
    .post(
      '/external-agents/:name/import/apply',
      ({ params, body }) =>
        handlers.externalAgentSettings.applyExternalAgentSettingsImport({ name: params.name, request: body }),
      {
        params: agentParams,
        body: externalAgentSettingsImportApplyRequestSchema,
        response: { 200: externalAgentSettingsImportApplyResultSchema },
        detail: { summary: 'Apply external agent settings import' }
      }
    )
    .put('/external-agents/:name', async ({ body }) => handlers.externalAgentSettings.upsertExternalAgent(body), {
      params: agentParams,
      body: upsertExternalAgentRequestSchema,
      response: { 200: okResponseSchema },
      detail: { summary: 'Upsert external agent' }
    })
    .post(
      '/external-agents/:name/enable',
      async ({ params }) =>
        handlers.externalAgentSettings.setExternalAgentEnabled({ name: params.name, enabled: true }),
      {
        params: agentParams,
        response: { 200: okResponseSchema, 404: httpErrorSchema },
        detail: { summary: 'Enable external agent' }
      }
    )
    .post(
      '/external-agents/:name/disable',
      async ({ params }) =>
        handlers.externalAgentSettings.setExternalAgentEnabled({ name: params.name, enabled: false }),
      {
        params: agentParams,
        response: { 200: okResponseSchema, 404: httpErrorSchema },
        detail: { summary: 'Disable external agent' }
      }
    )
    .delete(
      '/external-agents/:name',
      async ({ params }) => handlers.externalAgentSettings.removeExternalAgent({ name: params.name }),
      {
        params: agentParams,
        response: { 200: okResponseSchema, 404: httpErrorSchema },
        detail: { summary: 'Remove external agent' }
      }
    );
}
