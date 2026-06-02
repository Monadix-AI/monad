import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import {
  agentCredentialCapabilitySchema,
  agentCredentialErrorResponseSchema,
  agentCredentialViewSchema,
  createAgentCredentialRequestSchema,
  deleteAgentCredentialResponseSchema,
  listAgentCredentialsResponseSchema,
  updateAgentCredentialRequestSchema
} from '@monad/protocol';
import { Elysia } from 'elysia';
import { z } from 'zod';

const credentialParamsSchema = z.object({ id: z.string().min(1) });

export function createCredentialSettingsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  return new Elysia({ tags: ['http-only'] })
    .get('/credentials', async () => handlers.credential.listCredentials(), {
      response: { 200: listAgentCredentialsResponseSchema },
      detail: { summary: 'List Agent Credentials' }
    })
    .post('/credentials', async ({ body, status }) => status(201, await handlers.credential.createCredential(body)), {
      body: createAgentCredentialRequestSchema,
      response: { 201: agentCredentialViewSchema },
      detail: { summary: 'Create Agent Credential' }
    })
    .get('/credentials/capability', async () => handlers.credential.getCapability(), {
      response: { 200: agentCredentialCapabilitySchema },
      detail: { summary: 'Get protected-execution capability' }
    })
    .patch('/credentials/:id', async ({ params, body }) => handlers.credential.updateCredential(params.id, body), {
      params: credentialParamsSchema,
      body: updateAgentCredentialRequestSchema,
      response: { 200: agentCredentialViewSchema, 404: agentCredentialErrorResponseSchema },
      detail: { summary: 'Update Agent Credential' }
    })
    .delete('/credentials/:id', async ({ params }) => handlers.credential.deleteCredential(params.id), {
      params: credentialParamsSchema,
      response: { 200: deleteAgentCredentialResponseSchema, 404: agentCredentialErrorResponseSchema },
      detail: { summary: 'Delete Agent Credential' }
    });
}
