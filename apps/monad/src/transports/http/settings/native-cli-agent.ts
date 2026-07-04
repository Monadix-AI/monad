import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import {
  listNativeCliAgentPresetsResponseSchema,
  listNativeCliAgentsResponseSchema,
  listNativeCliSettingsImportCandidatesResponseSchema,
  nativeCliSettingsImportApplyRequestSchema,
  nativeCliSettingsImportApplyResultSchema,
  nativeCliSettingsImportPreviewRequestSchema,
  nativeCliSettingsImportPreviewSchema,
  okResponseSchema,
  upsertNativeCliAgentRequestSchema
} from '@monad/protocol';
import { Elysia } from 'elysia';
import { z } from 'zod';

const agentParams = z.object({ name: z.string() });

export function createNativeCliAgentSettingsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  return new Elysia({ tags: ['http-only'] })
    .get('/native-cli-agents', async () => handlers.nativeCliAgent.listNativeCliAgents(), {
      response: { 200: listNativeCliAgentsResponseSchema },
      detail: { summary: 'List native CLI agents' }
    })
    .get('/native-cli-agents/presets', () => handlers.nativeCliAgent.listNativeCliAgentPresets(), {
      response: { 200: listNativeCliAgentPresetsResponseSchema },
      detail: { summary: 'List native CLI agent presets' }
    })
    .get(
      '/native-cli-agents/:name/import/candidates',
      ({ params }) => handlers.nativeCliAgent.listNativeCliSettingsImportCandidates({ name: params.name }),
      {
        params: agentParams,
        response: { 200: listNativeCliSettingsImportCandidatesResponseSchema },
        detail: { summary: 'List native CLI agent settings import candidates' }
      }
    )
    .post(
      '/native-cli-agents/:name/import/preview',
      ({ params, body }) =>
        handlers.nativeCliAgent.previewNativeCliSettingsImport({ name: params.name, request: body }),
      {
        params: agentParams,
        body: nativeCliSettingsImportPreviewRequestSchema,
        response: { 200: nativeCliSettingsImportPreviewSchema },
        detail: { summary: 'Preview native CLI agent settings import' }
      }
    )
    .post(
      '/native-cli-agents/:name/import/apply',
      ({ params, body }) => handlers.nativeCliAgent.applyNativeCliSettingsImport({ name: params.name, request: body }),
      {
        params: agentParams,
        body: nativeCliSettingsImportApplyRequestSchema,
        response: { 200: nativeCliSettingsImportApplyResultSchema },
        detail: { summary: 'Apply native CLI agent settings import' }
      }
    )
    .put('/native-cli-agents', async ({ body }) => handlers.nativeCliAgent.upsertNativeCliAgent(body), {
      body: upsertNativeCliAgentRequestSchema,
      response: { 200: okResponseSchema },
      detail: { summary: 'Upsert native CLI agent' }
    })
    .post(
      '/native-cli-agents/:name/enable',
      async ({ params }) => handlers.nativeCliAgent.setNativeCliAgentEnabled({ name: params.name, enabled: true }),
      { params: agentParams, response: { 200: okResponseSchema }, detail: { summary: 'Enable native CLI agent' } }
    )
    .post(
      '/native-cli-agents/:name/disable',
      async ({ params }) => handlers.nativeCliAgent.setNativeCliAgentEnabled({ name: params.name, enabled: false }),
      { params: agentParams, response: { 200: okResponseSchema }, detail: { summary: 'Disable native CLI agent' } }
    )
    .delete(
      '/native-cli-agents/:name',
      async ({ params }) => handlers.nativeCliAgent.removeNativeCliAgent({ name: params.name }),
      {
        params: agentParams,
        response: { 200: okResponseSchema },
        detail: { summary: 'Remove native CLI agent' }
      }
    );
}
