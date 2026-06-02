import type { Agent, AgentCredentialView } from '@monad/protocol';

import { expect, type Page, test } from '@playwright/test';

import { API_ROUTE_PATTERN } from './api-route-pattern';

function json(body: unknown, status = 200) {
  return { body: JSON.stringify(body), contentType: 'application/json', status };
}

async function installAgentCredentialApi(
  page: Page,
  state: {
    agent: Agent;
    credential?: AgentCredentialView;
  }
) {
  await page.route(API_ROUTE_PATTERN, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!(url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/') || url.pathname === '/health')) {
      return route.continue();
    }
    const path = url.pathname.replace('/api/v1', '/v1').replace('/api/health', '/health');
    const method = request.method();

    if (path === '/health') return route.fulfill(json({ status: 'ok', version: '0.1.1', latestVersion: '0.1.1' }));
    if (path === '/v1/init/status') {
      return route.fulfill(json({ initialized: true, missing: [], homePath: '/tmp/monad-grants-e2e' }));
    }
    if (path === '/v1/sessions') return route.fulfill(json({ sessions: [], total: 0, limit: 50, offset: 0 }));
    if (path === '/v1/commands') return route.fulfill(json({ commands: [] }));
    if (path === '/v1/settings/locale') return route.fulfill(json({ locale: 'en' }));
    if (path === '/v1/settings/locales') {
      return route.fulfill(json({ locales: [{ locale: 'en', label: 'English', source: 'built-in' }] }));
    }
    if (path === '/v1/i18n/catalog') return route.fulfill(json({ locale: 'en', messages: {} }));
    if (path === '/v1/settings/model/providers') return route.fulfill(json({ providers: [] }));
    if (path === '/v1/settings/model/profiles') {
      return route.fulfill(json({ profiles: [], defaultAlias: 'default' }));
    }
    if (path === '/v1/settings/model/roles') return route.fulfill(json({ roles: {} }));
    if (path === '/v1/atoms') return route.fulfill(json({ atomPacks: [], conflicts: [] }));
    if (path === '/v1/settings/mcp-servers') return route.fulfill(json({ servers: [] }));
    if (path === '/v1/skills') return route.fulfill(json({ skills: [], skillInstances: [] }));
    if (path === '/v1/settings/capability-inventory') return route.fulfill(json({ items: [] }));
    if (path === '/v1/memory/status') return route.fulfill(json({ available: true }));
    if (path === '/v1/memory/facts') {
      return route.fulfill(json({ facts: [], nextCursor: null, hasMore: false, total: 0 }));
    }
    if (path === '/v1/agents' && method === 'GET') return route.fulfill(json({ agents: [state.agent] }));
    if (path === `/v1/agents/${state.agent.id}` && method === 'GET') {
      return route.fulfill(json({ agent: state.agent }));
    }
    if (path === `/v1/agents/${state.agent.id}` && method === 'PATCH') {
      state.agent = { ...state.agent, ...(request.postDataJSON() as Partial<Agent>) };
      return route.fulfill(json({ agent: state.agent }));
    }
    if (path === `/v1/agents/${state.agent.id}/prompt`) {
      return route.fulfill(json({ slots: { agent: '', user: '' } }));
    }
    if (path === `/v1/agents/${state.agent.id}/a2a`) {
      return route.fulfill(json({ status: { enabled: false } }));
    }
    if (path === '/v1/settings/credentials/capability') return route.fulfill(json({ available: true }));
    if (path === '/v1/settings/credentials' && method === 'GET') {
      const credential = state.credential
        ? {
            ...state.credential,
            authorizedAgentIds: state.agent.credentialIds.includes(state.credential.id) ? [state.agent.id] : []
          }
        : undefined;
      return route.fulfill(json({ credentials: credential ? [credential] : [] }));
    }
    if (path === '/v1/settings/credentials' && method === 'POST') {
      const body = request.postDataJSON() as {
        allowedHosts: string[];
        description?: string;
        environmentVariable: string;
        label: string;
      };
      state.credential = {
        id: 'credential-grant-e2e',
        label: body.label,
        ...(body.description ? { description: body.description } : {}),
        environmentVariable: body.environmentVariable,
        allowedHosts: body.allowedHosts,
        configured: true,
        authorizedAgentIds: []
      };
      return route.fulfill(json(state.credential));
    }
    if (path === '/v1/settings/credentials/credential-grant-e2e' && method === 'DELETE') {
      state.agent = { ...state.agent, credentialIds: [] };
      state.credential = undefined;
      return route.fulfill(json({ ok: true, affectedAgentIds: [state.agent.id] }));
    }
    return route.fulfill(json({}));
  });
}

async function openSandbox(page: Page) {
  await page.getByText('Sandbox', { exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Sandbox' })).toBeVisible();
}

test('persists, reloads, revokes, and atomically removes agent credential grants', async ({ page }) => {
  test.setTimeout(60_000);
  const state: { agent: Agent; credential?: AgentCredentialView } = {
    agent: {
      id: 'agt_grants000001',
      name: 'Grant Tester',
      capabilities: [],
      credentialIds: [],
      declaredScopes: [],
      memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 },
      visibility: { subagentCallable: false, public: false },
      a2a: { enabled: false },
      monadix: { consume: false }
    }
  };
  await installAgentCredentialApi(page, state);

  await page.goto('/studio/credentials');
  await page.getByRole('button', { name: 'New credential' }).click();
  await page.getByLabel('Label').fill('GitHub runtime');
  await page.getByLabel('Environment variable').fill('GITHUB_TOKEN');
  await page.getByLabel('Allowed hosts').fill('api.github.com');
  await page.getByLabel('Secret').fill('grant-secret-canary');
  await page.getByRole('button', { name: 'New credential' }).last().click();

  await page.goto(`/studio/agents/${state.agent.id}/edit`);
  await openSandbox(page);
  const grant = page.getByRole('switch', { name: 'GitHub runtime' });
  await expect(grant).not.toBeChecked();
  await grant.click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => state.agent.credentialIds).toEqual(['credential-grant-e2e']);

  await page.reload();
  await page.getByRole('button', { name: 'Edit' }).click();
  await openSandbox(page);
  await expect(page.getByRole('switch', { name: 'GitHub runtime' })).toBeChecked();
  await page.getByRole('switch', { name: 'GitHub runtime' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => state.agent.credentialIds).toEqual([]);

  await page.getByRole('button', { name: 'Edit' }).click();
  await openSandbox(page);
  await page.getByRole('switch', { name: 'GitHub runtime' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => state.agent.credentialIds).toEqual(['credential-grant-e2e']);
  await page.goto('/studio/credentials');
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText(/Grant Tester/)).toBeVisible();
  await page.getByRole('button', { name: 'Delete' }).last().click();
  await expect.poll(() => state.agent.credentialIds).toEqual([]);

  await page.goto(`/studio/agents/${state.agent.id}/edit`);
  await openSandbox(page);
  await expect(page.getByText('No runtime credentials are available')).toBeVisible();
  await expect(page.getByText('grant-secret-canary')).toHaveCount(0);
});
