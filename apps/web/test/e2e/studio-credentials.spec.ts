import type { AgentCredentialView } from '@monad/protocol';

import { expect, type Page, test } from '@playwright/test';

import { API_ROUTE_PATTERN } from './api-route-pattern';

function json(body: unknown, status = 200) {
  return { body: JSON.stringify(body), contentType: 'application/json', status };
}

async function installCredentialApi(
  page: Page,
  state: {
    credential?: AgentCredentialView;
    mutationBodies: unknown[];
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
      return route.fulfill(json({ initialized: true, missing: [], homePath: '/tmp/monad-credential-e2e' }));
    }
    if (path === '/v1/sessions') return route.fulfill(json({ sessions: [], total: 0, limit: 50, offset: 0 }));
    if (path === '/v1/commands') return route.fulfill(json({ commands: [] }));
    if (path === '/v1/settings/locale') return route.fulfill(json({ locale: 'en' }));
    if (path === '/v1/settings/locales') {
      return route.fulfill(json({ locales: [{ locale: 'en', label: 'English', source: 'built-in' }] }));
    }
    if (path === '/v1/i18n/catalog') return route.fulfill(json({ locale: 'en', messages: {} }));
    if (path === '/v1/agents') {
      return route.fulfill(
        json({
          agents: [
            {
              id: 'agt_builder000001',
              name: 'Builder',
              capabilities: [],
              credentialIds: state.credential ? ['credential-e2e'] : [],
              declaredScopes: [],
              visibility: { subagentCallable: false, public: false },
              a2a: { enabled: false },
              monadix: { consume: false }
            }
          ]
        })
      );
    }
    if (path === '/v1/settings/credentials/capability') return route.fulfill(json({ available: true }));
    if (path === '/v1/settings/credentials' && method === 'GET') {
      return route.fulfill(json({ credentials: state.credential ? [state.credential] : [] }));
    }
    if (path === '/v1/settings/credentials' && method === 'POST') {
      const body = request.postDataJSON() as {
        allowedHosts: string[];
        description?: string;
        environmentVariable: string;
        label: string;
      };
      state.mutationBodies.push(body);
      state.credential = {
        id: 'credential-e2e',
        label: body.label,
        ...(body.description ? { description: body.description } : {}),
        environmentVariable: body.environmentVariable,
        allowedHosts: body.allowedHosts,
        configured: true,
        authorizedAgentIds: ['agt_builder000001']
      };
      return route.fulfill(json(state.credential));
    }
    if (path === '/v1/settings/credentials/credential-e2e' && method === 'PATCH') {
      const body = request.postDataJSON() as Partial<AgentCredentialView>;
      state.mutationBodies.push(body);
      if (!state.credential) return route.fulfill(json({ error: 'not found' }, 404));
      state.credential = { ...state.credential, ...body, configured: true };
      return route.fulfill(json(state.credential));
    }
    if (path === '/v1/settings/credentials/credential-e2e' && method === 'DELETE') {
      state.credential = undefined;
      return route.fulfill(json({ ok: true, affectedAgentIds: ['agt_builder000001'] }));
    }
    return route.fulfill(json({}));
  });
}

test('manages write-only Agent Runtime Credentials and explains protected use', async ({ page }) => {
  const state: { credential?: AgentCredentialView; mutationBodies: unknown[] } = { mutationBodies: [] };
  await installCredentialApi(page, state);
  await page.goto('/studio/credentials');

  const help = page.getByRole('button', { name: 'About Agent Runtime Credentials' }).first();
  await help.hover();
  await expect(page.getByText('Use these only from generated Code Act')).toBeVisible();
  await help.focus();
  await expect(page.getByRole('link', { name: 'Learn more' })).toBeVisible();
  await page.getByRole('link', { name: 'Learn more' }).click();
  await expect(page).toHaveURL(/\/studio\/credentials#how-to-use$/);
  await expect(page.getByRole('heading', { name: 'How to use Credentials' })).toBeVisible();

  await page.getByRole('button', { name: 'New credential' }).click();
  await page.getByLabel('Label').fill('GitHub');
  await page.getByLabel('Description').fill('Repository automation');
  await page.getByLabel('Environment variable').fill('GITHUB_TOKEN');
  await page.getByLabel('Allowed hosts').fill('api.github.com');
  await page.getByLabel('Secret').fill('browser-secret-canary');
  await page.getByRole('button', { name: 'New credential' }).last().click();

  await expect(page.getByRole('heading', { name: 'GitHub' })).toBeVisible();
  await expect(page.getByText('api.github.com')).toBeVisible();
  await expect(page.getByText('Builder')).toHaveCount(0);
  await expect(page.getByText('browser-secret-canary')).toHaveCount(0);
  expect(
    JSON.stringify(
      await page.evaluate(() => ({ localStorage: { ...localStorage }, sessionStorage: { ...sessionStorage } }))
    )
  ).not.toContain('browser-secret-canary');

  await page.getByRole('button', { name: 'Edit credential' }).click();
  await page.getByLabel('Description').fill('Updated automation');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Updated automation')).toBeVisible();

  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText(/Builder/)).toBeVisible();
  await page.getByRole('button', { name: 'Delete' }).last().click();
  await expect(page.getByText('No runtime credentials yet')).toBeVisible();

  expect(JSON.stringify(state.mutationBodies)).toContain('browser-secret-canary');
  expect(JSON.stringify(state.mutationBodies[1])).not.toContain('browser-secret-canary');
});
