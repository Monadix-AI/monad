import type { MonadPaths } from '@monad/environment';
import type { TransportKind } from '../helpers.ts';

import { expect } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome, loadAll, loadAuth, loadConfig } from '@monad/environment';

import { ModelService } from '#/handlers/settings/model/index.ts';
import { createHttpTransport } from '#/transports/http.ts';
import {
  buildHandlers,
  createTestConfigManager,
  makeTestPaths,
  mockModel,
  seededProviderRegistry,
  serveTransport
} from '../helpers.ts';

const secretCanary = 'credential-e2e-secret-canary';

function request(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  };
}

async function setup(kind: TransportKind) {
  const dir = join(tmpdir(), `monad-credential-${kind}-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`);
  const paths: MonadPaths = makeTestPaths(dir);
  await initMonadHome(paths);
  const cfg = await loadConfig(paths);
  if (!cfg) throw new Error('config missing after init');
  const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry());
  const configManager = await createTestConfigManager(paths);
  const app = createHttpTransport(buildHandlers(mockModel(), { paths, modelService }, { configManager }));
  return { dir, paths, transport: serveTransport(kind, app) };
}

export async function runCredentialSettings(kind: TransportKind): Promise<void> {
  const { dir, paths, transport } = await setup(kind);
  try {
    let response = await transport.fetch('/v1/settings/credentials');
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: { credentials: [] }
    });

    response = await transport.fetch('/v1/settings/credentials/capability');
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: { available: false, code: 'protected_execution_unavailable' }
    });

    response = await transport.fetch(
      '/v1/settings/credentials',
      request('POST', {
        label: 'GitHub',
        description: 'GitHub API',
        environmentVariable: 'GITHUB_TOKEN',
        secret: secretCanary,
        allowedHosts: [' GitHub.COM ', 'api.github.com']
      })
    );
    const created = (await response.json()) as {
      id: string;
      label: string;
      description?: string;
      environmentVariable: string;
      allowedHosts: string[];
      configured: boolean;
      authorizedAgentIds: string[];
    };
    expect({ status: response.status, body: created }).toEqual({
      status: 201,
      body: {
        id: created.id,
        label: 'GitHub',
        description: 'GitHub API',
        environmentVariable: 'GITHUB_TOKEN',
        allowedHosts: ['github.com', 'api.github.com'],
        configured: true,
        authorizedAgentIds: []
      }
    });
    expect(JSON.stringify(created)).not.toContain(secretCanary);
    expect((await loadAuth(paths.auth))?.credentials[created.id]?.secret).toBe(secretCanary);

    response = await transport.fetch(
      '/v1/agents',
      request('POST', { name: 'Credential Agent', credentialIds: [created.id] })
    );
    expect(response.status).toBe(201);
    const agentId = ((await response.json()) as { agent: { id: string } }).agent.id;

    response = await transport.fetch('/v1/settings/credentials');
    expect(await response.json()).toEqual({
      credentials: [{ ...created, authorizedAgentIds: [agentId] }]
    });

    response = await transport.fetch(
      `/v1/settings/credentials/${created.id}`,
      request('PATCH', { label: 'GitHub production' })
    );
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: {
        ...created,
        label: 'GitHub production',
        authorizedAgentIds: [agentId]
      }
    });
    expect((await loadAuth(paths.auth))?.credentials[created.id]?.secret).toBe(secretCanary);

    response = await transport.fetch(
      `/v1/settings/credentials/${created.id}`,
      request('PATCH', { secret: { action: 'replace', value: 'replacement-e2e-canary' } })
    );
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: {
        ...created,
        label: 'GitHub production',
        authorizedAgentIds: [agentId]
      }
    });
    expect((await loadAuth(paths.auth))?.credentials[created.id]?.secret).toBe('replacement-e2e-canary');

    response = await transport.fetch(
      `/v1/settings/credentials/${created.id}`,
      request('PATCH', { secret: { action: 'remove' } })
    );
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: {
        ...created,
        label: 'GitHub production',
        configured: false,
        authorizedAgentIds: [agentId]
      }
    });
    expect((await loadAuth(paths.auth))?.credentials[created.id]?.secret).toBeUndefined();

    response = await transport.fetch(
      `/v1/agents/${agentId}`,
      request('PATCH', { credentialIds: ['cred_missing00000'] })
    );
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 400,
      body: {
        error: 'agent_credential_not_found',
        code: 'AGENT_CREDENTIAL_NOT_FOUND',
        retryable: false,
        requestId: expect.stringMatching(/^req_[0-9A-Za-z]{12}$/),
        details: { credentialId: 'cred_missing00000' }
      }
    });
    expect((await loadAll(paths))?.agent.agents.find((agent) => agent.id === agentId)?.credentialIds).toEqual([
      created.id
    ]);

    response = await transport.fetch(
      '/v1/settings/credentials/cred_missing00000',
      request('PATCH', { label: 'Missing' })
    );
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 404,
      body: {
        error: 'agent_credential_not_found',
        code: 'AGENT_CREDENTIAL_NOT_FOUND',
        retryable: false,
        requestId: expect.stringMatching(/^req_[0-9A-Za-z]{12}$/),
        details: { credentialId: 'cred_missing00000' }
      }
    });

    response = await transport.fetch(`/v1/settings/credentials/${created.id}`, request('DELETE'));
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: { ok: true, affectedAgentIds: [agentId] }
    });
    expect((await loadAuth(paths.auth))?.credentials).toEqual({});
    expect((await loadAll(paths))?.agent.agents.find((agent) => agent.id === agentId)?.credentialIds).toEqual([]);
  } finally {
    await transport.stop();
    await rm(dir, { recursive: true, force: true });
  }
}
