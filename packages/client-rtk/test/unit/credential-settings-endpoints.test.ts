import type { MonadClient } from '@monad/client';
import type { AgentCredentialView } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { createAgentCredentialApi } from '../../src/endpoints/settings/credentials/create-credential.ts';
import { deleteAgentCredentialApi } from '../../src/endpoints/settings/credentials/delete-credential.ts';
import { getAgentCredentialCapabilityApi } from '../../src/endpoints/settings/credentials/get-capability.ts';
import { listAgentCredentialsApi } from '../../src/endpoints/settings/credentials/list-credentials.ts';
import { updateAgentCredentialApi } from '../../src/endpoints/settings/credentials/update-credential.ts';
import { createMonadStore } from '../../src/index.ts';

const view: AgentCredentialView = {
  id: 'cred_000000CLIENT',
  label: 'Primary API',
  description: 'Read metrics',
  environmentVariable: 'PRIMARY_API_TOKEN',
  allowedHosts: ['api.example.com'],
  configured: true,
  authorizedAgentIds: []
};

function ok<T>(data: T) {
  return { data, error: null, status: 200 };
}

test('Agent Credential endpoints use exact paths and never cache mutation secrets', async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const credentialRoute = (params: { id: string }) => ({
    patch: async (body: unknown) => {
      calls.push({ method: 'PATCH', path: `/v1/settings/credentials/${params.id}`, body });
      return ok(view);
    },
    delete: async () => {
      calls.push({ method: 'DELETE', path: `/v1/settings/credentials/${params.id}` });
      return ok({ ok: true as const, affectedAgentIds: [] });
    }
  });
  Object.assign(credentialRoute, {
    get: async () => {
      calls.push({ method: 'GET', path: '/v1/settings/credentials' });
      return ok({ credentials: [view] });
    },
    post: async (body: unknown) => {
      calls.push({ method: 'POST', path: '/v1/settings/credentials', body });
      return ok(view);
    },
    capability: {
      get: async () => {
        calls.push({ method: 'GET', path: '/v1/settings/credentials/capability' });
        return ok({ available: true });
      }
    }
  });
  const client = {
    treaty: { v1: { settings: { credentials: credentialRoute } } }
  } as unknown as MonadClient;
  const store = createMonadStore({ client });
  const createBody = {
    label: 'Primary API',
    description: 'Read metrics',
    environmentVariable: 'PRIMARY_API_TOKEN',
    allowedHosts: ['api.example.com'],
    secret: 'client-mutation-secret-canary'
  };
  const updateBody = {
    credentialId: view.id,
    patch: { secret: { action: 'replace' as const, value: 'client-replacement-secret-canary' } }
  };

  await store.dispatch(listAgentCredentialsApi.endpoints.listAgentCredentials.initiate()).unwrap();
  await store.dispatch(getAgentCredentialCapabilityApi.endpoints.getAgentCredentialCapability.initiate()).unwrap();
  await store.dispatch(createAgentCredentialApi.endpoints.createAgentCredential.initiate(createBody)).unwrap();
  await store.dispatch(updateAgentCredentialApi.endpoints.updateAgentCredential.initiate(updateBody)).unwrap();
  await store.dispatch(deleteAgentCredentialApi.endpoints.deleteAgentCredential.initiate(view.id)).unwrap();

  expect(calls).toEqual([
    { method: 'GET', path: '/v1/settings/credentials' },
    { method: 'GET', path: '/v1/settings/credentials/capability' },
    { method: 'POST', path: '/v1/settings/credentials', body: createBody },
    { method: 'GET', path: '/v1/settings/credentials' },
    { method: 'PATCH', path: `/v1/settings/credentials/${view.id}`, body: updateBody.patch },
    { method: 'GET', path: '/v1/settings/credentials' },
    { method: 'DELETE', path: `/v1/settings/credentials/${view.id}` },
    { method: 'GET', path: '/v1/settings/credentials' }
  ]);
  const cached = Object.values(store.getState().monadApi.queries).find(
    (entry) => entry?.endpointName === 'listAgentCredentials'
  );
  expect(cached?.data).toEqual({ credentials: [view] });
  expect(JSON.stringify(store.getState())).not.toContain('client-mutation-secret-canary');
  expect(JSON.stringify(store.getState())).not.toContain('client-replacement-secret-canary');

  store.dispatch(listAgentCredentialsApi.util.resetApiState());
});
