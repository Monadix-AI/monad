import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import {
  addCredentialBodySchema,
  addCredentialResponseSchema,
  discoverAtomKindsResponseSchema,
  getDefaultProfileResponseSchema,
  getProviderCatalogResponseSchema,
  getRolesResponseSchema,
  listAtomKindsResponseSchema,
  listCredentialsResponseSchema,
  listModelsResponseSchema,
  listProfilesResponseSchema,
  listProvidersResponseSchema,
  okResponseSchema,
  renameProfileRequestSchema,
  setDefaultProfileRequestSchema,
  setProfileRequestSchema,
  setProviderRequestSchema,
  setRolesRequestSchema,
  testConnectionRequestSchema,
  testConnectionResponseSchema,
  testCredentialBodySchema,
  testCredentialResponseSchema
} from '@monad/protocol';
import { Elysia } from 'elysia';
import { z } from 'zod';

// Model config is part of the settings family — HTTP-only (no JSON-RPC twin), so the endpoint
// contract is declared inline here; reusable wire schemas come from @monad/protocol. The id/alias
// params are plain strings, so they stay transport-local.
const providerParams = z.object({ id: z.string() });
const profileParams = z.object({ alias: z.string() });
const credentialParams = z.object({ id: z.string(), credId: z.string() });

export function createModelSettingsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  return new Elysia({ tags: ['http-only'] })
    .get('/model/providers', async () => handlers.model.listProviders(), {
      response: { 200: listProvidersResponseSchema },
      detail: { summary: 'List model providers', description: 'Returns configured model providers.' }
    })
    .put('/model/providers/:id', async ({ body }) => handlers.model.setProvider(body), {
      params: providerParams,
      body: setProviderRequestSchema,
      response: { 200: okResponseSchema },
      detail: { summary: 'Set model provider', description: 'Upserts a provider configuration.' }
    })
    .get('/model/providers/catalog', async () => handlers.model.providerCatalog(), {
      response: { 200: getProviderCatalogResponseSchema },
      detail: {
        summary: 'Provider catalog',
        description: 'Self-describing metadata for every registered provider (first- and third-party).'
      }
    })
    .delete('/model/providers/:id', async ({ params }) => handlers.model.deleteProvider({ id: params.id }), {
      params: providerParams,
      response: { 200: okResponseSchema },
      detail: { summary: 'Delete model provider', description: 'Deletes one provider by id.' }
    })
    .get('/model/profiles', async () => handlers.model.listProfiles(), {
      response: { 200: listProfilesResponseSchema },
      detail: { summary: 'List model profiles', description: 'Returns configured model profiles and default alias.' }
    })
    .put('/model/profiles/:alias', async ({ body }) => handlers.model.setProfile(body), {
      params: profileParams,
      body: setProfileRequestSchema,
      response: { 200: okResponseSchema },
      detail: { summary: 'Set model profile', description: 'Upserts a model profile configuration.' }
    })
    .patch(
      '/model/profiles/:alias/alias',
      async ({ params, body }) => handlers.model.renameProfile({ alias: params.alias, nextAlias: body.alias }),
      {
        params: profileParams,
        body: renameProfileRequestSchema,
        response: { 200: okResponseSchema },
        detail: {
          summary: 'Rename model profile',
          description: 'Renames a profile and rewrites default/agent references in one config commit.'
        }
      }
    )
    .delete('/model/profiles/:alias', async ({ params }) => handlers.model.deleteProfile({ alias: params.alias }), {
      params: profileParams,
      response: { 200: okResponseSchema },
      detail: { summary: 'Delete model profile', description: 'Deletes one model profile by alias.' }
    })
    .get('/model/default', async () => handlers.model.getDefaultProfile(), {
      response: { 200: getDefaultProfileResponseSchema },
      detail: { summary: 'Get default model profile', description: 'Returns the current default profile alias.' }
    })
    .put('/model/default', async ({ body }) => handlers.model.setDefaultProfile(body), {
      body: setDefaultProfileRequestSchema,
      response: { 200: okResponseSchema },
      detail: { summary: 'Set default model profile', description: 'Sets the default profile alias.' }
    })
    .get('/model/roles', async () => handlers.model.getRoles(), {
      response: { 200: getRolesResponseSchema },
      detail: { summary: 'Get model role assignments', description: 'vision/image/speech/embedding model assignments.' }
    })
    .put('/model/roles', async ({ body }) => handlers.model.setRoles(body), {
      body: setRolesRequestSchema,
      response: { 200: okResponseSchema },
      detail: { summary: 'Set model role assignments', description: 'Replaces the non-chat model role assignments.' }
    })
    .post('/model/embeddings/reindex', async () => handlers.embeddings.reindex(), {
      response: { 200: okResponseSchema },
      detail: {
        summary: 'Re-index embeddings',
        description: 'Clears all stored embeddings and rebuilds them with the current embedding model.'
      }
    })
    .get('/model/providers/:id/models', async ({ params }) => handlers.model.listModels({ providerId: params.id }), {
      params: providerParams,
      response: { 200: listModelsResponseSchema },
      detail: { summary: 'List provider models', description: 'Returns models exposed by a provider id.' }
    })
    .get(
      '/model/providers/:id/credentials',
      async ({ params }) => handlers.model.listCredentials({ providerId: params.id }),
      {
        params: providerParams,
        response: { 200: listCredentialsResponseSchema },
        detail: { summary: 'List provider credentials', description: 'Returns stored credentials for a provider.' }
      }
    )
    .post(
      '/model/providers/:id/credentials',
      async ({ params, body, status }) =>
        status(201, await handlers.model.addCredential({ ...body, providerId: params.id })),
      {
        params: providerParams,
        body: addCredentialBodySchema,
        response: { 201: addCredentialResponseSchema },
        detail: { summary: 'Add provider credential', description: 'Adds a credential to a provider.' }
      }
    )
    .delete(
      '/model/providers/:id/credentials/:credId',
      async ({ params }) => handlers.model.deleteCredential({ providerId: params.id, credentialId: params.credId }),
      {
        params: credentialParams,
        response: { 200: okResponseSchema },
        detail: { summary: 'Delete provider credential', description: 'Deletes a credential from a provider.' }
      }
    )
    .post(
      '/model/providers/:id/credentials/:credId/test',
      async ({ params, body }) =>
        handlers.model.testCredential({
          providerId: params.id,
          credentialId: params.credId,
          modelId: body?.modelId
        }),
      {
        params: credentialParams,
        body: testCredentialBodySchema,
        response: { 200: testCredentialResponseSchema },
        detail: { summary: 'Test provider credential', description: 'Runs a lightweight credential validation test.' }
      }
    )
    .post('/model/test-connection', async ({ body }) => handlers.model.testConnection(body), {
      body: testConnectionRequestSchema,
      response: { 200: testConnectionResponseSchema },
      detail: {
        summary: 'Test provider connection',
        description: 'Tests provider connectivity and optionally returns discovered models.'
      }
    })
    .get('/model/atom-kinds', async () => handlers.model.listAtomKinds(), {
      response: { 200: listAtomKindsResponseSchema },
      detail: {
        summary: 'List registered atom kinds',
        description: 'Returns the kind strings of all currently registered model provider atom packs.'
      }
    })
    .post('/model/atom-kinds/discover', async () => handlers.model.discoverAtomKinds(), {
      response: { 200: discoverAtomKindsResponseSchema },
      detail: {
        summary: 'Discover provider atom packs',
        description: 'Scans the providers directory for new atom pack files and registers any found.'
      }
    });
}
