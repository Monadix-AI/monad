import { expect, type Page, test } from '@playwright/test';

import { API_ROUTE_PATTERN } from './api-route-pattern';

function json(body: unknown, status = 200) {
  return {
    body: JSON.stringify(body),
    contentType: 'application/json',
    status
  };
}

async function installInitOnboardingApiMock(
  page: Page,
  options: {
    onCreateProject?: (body: unknown) => void;
    onUpdateProject?: (body: unknown) => void;
  } = {}
) {
  let connectedAgent: Record<string, unknown> | null = null;
  await page.route(API_ROUTE_PATTERN, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!(url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/') || url.pathname === '/health')) {
      return route.continue();
    }

    const path = url.pathname.replace('/api/v1', '/v1').replace('/api/health', '/health');
    const method = request.method();

    if (method === 'GET' && path === '/health') {
      return route.fulfill(json({ status: 'ok', version: '0.1.1', latestVersion: '0.1.1' }));
    }
    if (method === 'GET' && path === '/v1/init/status') {
      return route.fulfill(
        json({
          initialized: false,
          missing: ['provider', 'credential', 'default', 'agent'],
          homePath: '/tmp/monad-e2e-home'
        })
      );
    }
    if (method === 'GET' && path === '/v1/sessions') {
      return route.fulfill(json({ sessions: [], total: 0, limit: 50, offset: 0 }));
    }
    if (method === 'GET' && path === '/v1/commands') return route.fulfill(json({ commands: [] }));
    if (method === 'GET' && path === '/v1/settings/locale') return route.fulfill(json({ locale: 'en' }));
    if (method === 'GET' && path === '/v1/settings/locales') {
      return route.fulfill(json({ locales: [{ locale: 'en', label: 'English', source: 'built-in' }] }));
    }
    if (method === 'GET' && path === '/v1/i18n/catalog') {
      return route.fulfill(json({ locale: 'en', messages: {} }));
    }
    if (method === 'GET' && path === '/v1/settings/model/providers') {
      return route.fulfill(json({ providers: [] }));
    }
    if (method === 'GET' && path === '/v1/settings/model/profiles') {
      return route.fulfill(json({ defaultAlias: 'default', profiles: [] }));
    }
    if (method === 'GET' && path === '/v1/settings/model/providers/catalog') {
      return route.fulfill(json({ providers: [] }));
    }
    if (method === 'GET' && path === '/v1/settings/model/roles') {
      return route.fulfill(json({ roles: {} }));
    }
    if (method === 'GET' && path === '/v1/agents') {
      return route.fulfill(json({ agents: [] }));
    }
    if (method === 'GET' && path === '/v1/agents/default') {
      return route.fulfill(json({ agentId: null }));
    }
    if (method === 'GET' && path === '/v1/workplace/projects') {
      return route.fulfill(json({ projects: [], total: 0, limit: 50, offset: 0, orderRevision: 0 }));
    }
    if (method === 'GET' && path === '/v1/mesh/agents') {
      return route.fulfill(json({ agents: connectedAgent ? [connectedAgent] : [] }));
    }
    if (method === 'GET' && path === '/v1/mesh/agents/presets') {
      return route.fulfill(
        json({
          presets: [
            {
              id: 'codex',
              label: 'Codex',
              provider: 'codex',
              productIcon: 'codex',
              command: 'codex',
              args: [],
              installHint: 'Install Codex',
              installUrl: 'https://developers.openai.com/codex/cli',
              installed: true
            }
          ]
        })
      );
    }
    if (method === 'PUT' && path === '/v1/mesh/agents/codex') {
      connectedAgent = request.postDataJSON().agent;
      return route.fulfill(json({ ok: true }));
    }
    if (method === 'POST' && path === '/v1/mesh/agents/codex/auth/start') {
      const now = new Date().toISOString();
      return route.fulfill(
        json({
          session: {
            id: 'ncliauth_codex000001',
            controlToken: 'control-token-for-codex-auth-session-000001',
            agentName: 'codex',
            provider: 'codex',
            productIcon: 'codex',
            approvalOwnership: 'provider-owned',
            authState: 'authenticated',
            state: 'exited',
            pid: 0,
            outputSnapshot: '',
            exitCode: 0,
            startedAt: now,
            updatedAt: now,
            exitedAt: now
          }
        })
      );
    }
    if (method === 'POST' && path === '/v1/workplace/projects') {
      options.onCreateProject?.(request.postDataJSON());
      return route.fulfill(json({ projectId: 'prj_initproject0' }));
    }
    if (method === 'PATCH' && path === '/v1/workplace/projects/prj_initproject0') {
      const body = request.postDataJSON();
      options.onUpdateProject?.(body);
      const now = new Date().toISOString();
      return route.fulfill(
        json({
          project: {
            id: 'prj_initproject0',
            title: 'Launch plan',
            state: 'active',
            archived: false,
            memberTemplates: body.memberTemplates,
            autoInviteProjectMembers: body.autoInviteProjectMembers,
            createdAt: now,
            updatedAt: now
          }
        })
      );
    }

    return route.fulfill(json({}));
  });
}

test.describe('init onboarding', () => {
  test('uninitialized runtime does not redirect the main app to /init', async ({ page }) => {
    await installInitOnboardingApiMock(page);

    await page.goto('/');

    await expect(page).toHaveURL(/\/$/);
  });

  test('/init starts with Runtime and Mesh choices and Runtime can skip to home', async ({ page }) => {
    await installInitOnboardingApiMock(page);

    await page.goto('/init');

    await expect(page.getByRole('heading', { name: 'Choose how to start' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Configure Monad Agent Runtime/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Configure Monad Mesh/ })).toBeVisible();

    await page.getByRole('button', { name: /Configure Monad Agent Runtime/ }).click();
    await expect(page.getByRole('heading', { name: 'Connect model providers' })).toBeVisible();
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('/init Mesh setup shows installed agents and can skip to home', async ({ page }) => {
    await installInitOnboardingApiMock(page);

    await page.goto('/init');
    await page.getByRole('button', { name: /Configure Monad Mesh/ }).click();
    await expect(page.getByRole('heading', { name: 'Connect MeshAgents' })).toBeVisible();
    await expect(page.getByText('Codex', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('/init binds a CLI and creates a project with that CLI as an auto-invited member', async ({ page }) => {
    let createBody: unknown;
    let updateBody: unknown;
    await installInitOnboardingApiMock(page, {
      onCreateProject: (body) => {
        createBody = body;
      },
      onUpdateProject: (body) => {
        updateBody = body;
      }
    });

    await page.goto('/init');
    await page.getByRole('button', { name: /Configure Monad Mesh/ }).click();
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByText('1 MeshAgent connected.')).toBeVisible();
    await page.getByRole('button', { name: 'Continue →' }).click();

    await expect(page.getByRole('heading', { name: 'Create your first project' })).toBeVisible();
    await page.getByLabel('Project name').fill('Launch plan');
    await page.getByRole('button', { name: 'Create project' }).click();

    await expect(page).toHaveURL(/\/workspace\/prj_initproject0$/);
    expect(createBody).toEqual({ title: 'Launch plan', origin: { surface: 'web' } });
    expect(updateBody).toEqual({
      title: 'Launch plan',
      memberTemplates: [
        {
          id: expect.stringMatching(/^pmem_codex_/),
          type: 'mesh-agent',
          name: 'codex',
          displayName: 'Codex',
          settings: { managedProjectAgent: true }
        }
      ],
      autoInviteProjectMembers: true
    });
  });

  test('incomplete runtime keeps setup and Mesh tabs available while redirecting disabled runtime tabs', async ({
    page
  }) => {
    await installInitOnboardingApiMock(page);

    await page.goto('/studio/models');
    await expect(page).toHaveURL(/\/studio\/models$/);
    await expect(page.getByRole('heading', { name: 'Providers' })).toBeVisible();

    await page.goto('/studio/agents');
    await expect(page).toHaveURL(/\/studio\/runtime$/);
    await expect(page.getByRole('heading', { name: 'Runtime overview' })).toBeVisible();

    await page.goto('/studio/meshAgents');

    await expect(page).toHaveURL(/\/studio\/meshAgents$/);
    await expect(page.getByText('Codex', { exact: true })).toBeVisible();
  });
});
