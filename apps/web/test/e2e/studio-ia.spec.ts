import { expect, type Page, test } from '@playwright/test';

function json(body: unknown, status = 200) {
  return {
    body: JSON.stringify(body),
    contentType: 'application/json',
    status
  };
}

async function installStudioIaApiMock(page: Page) {
  await page.route('**/*', async (route) => {
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
      return route.fulfill(json({ initialized: true, missing: [], homePath: '/tmp/monad-e2e-home' }));
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
      return route.fulfill(
        json({
          providers: [
            {
              id: 'openai',
              type: 'openai',
              label: 'OpenAI',
              baseUrl: 'https://api.openai.com/v1',
              enabled: true
            }
          ]
        })
      );
    }
    if (method === 'GET' && path === '/v1/settings/model/profiles') {
      return route.fulfill(
        json({
          defaultAlias: 'default',
          profiles: [
            {
              alias: 'default',
              fallbacks: [],
              params: {},
              routes: { chat: { provider: 'openai', modelId: 'gpt-4.1' } }
            }
          ]
        })
      );
    }
    if (method === 'GET' && path === '/v1/settings/model/roles') {
      return route.fulfill(json({ roles: {} }));
    }
    if (method === 'GET' && path === '/v1/agents') {
      return route.fulfill(json({ agents: [{ id: 'agt_mock', name: 'Builder', hasPrompt: true }] }));
    }
    if (method === 'GET' && path === '/v1/workplace/projects') {
      return route.fulfill(
        json({
          projects: [
            {
              archived: false,
              createdAt: '2026-07-03T00:00:00.000Z',
              cwd: '/tmp/mock-workplace',
              id: 'prj_mock',
              ownerPrincipalId: 'prn_mock',
              state: 'ready',
              title: 'Mock Workplace',
              updatedAt: '2026-07-03T00:00:00.000Z'
            }
          ],
          total: 1,
          hasMore: false
        })
      );
    }
    if (method === 'GET' && path === '/v1/settings/native-cli-agents') {
      return route.fulfill(
        json({
          agents: [
            {
              name: 'codex',
              label: 'Codex',
              provider: 'codex',
              command: 'codex',
              args: [],
              enabled: true,
              launchMode: 'pty',
              approvalOwnership: 'provider',
              runtimeRole: 'workplace',
              capabilities: {
                filesystem: true,
                shell: true,
                browser: false,
                approvals: true
              }
            }
          ]
        })
      );
    }
    if (method === 'GET' && path === '/v1/settings/native-cli-agents/presets') {
      return route.fulfill(json({ presets: [] }));
    }

    return route.fulfill(json({}));
  });
}

test.describe('Studio IA', () => {
  test('opens on a beginner-friendly Runtime overview with advanced settings collapsed', async ({ page }) => {
    await installStudioIaApiMock(page);

    await page.goto('/studio/runtime');

    await expect(page.getByRole('heading', { name: 'Runtime overview' })).toBeVisible();
    await expect(page.getByText('Monad Runtime', { exact: true })).toBeVisible();
    await expect(page.getByText('Monad Mesh', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Set up Monad runtime' })).toBeVisible();
    await expect(page.getByTestId('studio-runtime-illustration')).toBeVisible();

    const advanced = page.locator('details').filter({ hasText: 'Advanced runtime settings' });
    await expect(advanced).toBeVisible();
    await expect(advanced.getByRole('link', { name: 'Capabilities' })).toBeHidden();

    await advanced.getByText('Show').click();
    await expect(advanced.getByRole('link', { name: 'Capabilities' })).toBeVisible();
    await expect(advanced.getByRole('link', { name: 'ACP delegates' })).toBeVisible();
  });

  test('moves Mesh-owned work out of Runtime into its own overview', async ({ page }) => {
    await installStudioIaApiMock(page);

    await page.goto('/studio/runtime');
    await page.getByRole('link', { name: 'Open Mesh overview' }).first().click();

    await expect(page).toHaveURL(/\/studio\/mesh$/);
    await expect(page.getByRole('heading', { name: 'Mesh overview' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Connect External Agents' })).toBeVisible();
    await expect(page.getByText('Monad Mesh', { exact: true })).toBeVisible();
    await expect(page.getByTestId('studio-mesh-illustration')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Project members' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Tasks and sessions' })).toHaveCount(0);
  });
});
