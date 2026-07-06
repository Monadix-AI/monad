import { expect, type Page, test } from '@playwright/test';

function json(body: unknown, status = 200) {
  return {
    body: JSON.stringify(body),
    contentType: 'application/json',
    status
  };
}

async function installInitOnboardingApiMock(page: Page) {
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
      return route.fulfill(json({ projects: [], total: 0, hasMore: false }));
    }
    if (method === 'GET' && path === '/v1/settings/native-cli-agents') {
      return route.fulfill(json({ agents: [] }));
    }
    if (method === 'GET' && path === '/v1/settings/native-cli-agents/presets') {
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
              defaultLaunchMode: 'pty',
              supportedLaunchModes: ['pty'],
              installHint: 'Install Codex',
              installUrl: 'https://developers.openai.com/codex/cli',
              installed: true
            }
          ]
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
    await expect(page.getByRole('heading', { level: 1, name: 'Workspace' })).toBeVisible();
  });

  test('/init starts with Runtime and Mesh choices that can both skip to home', async ({ page }) => {
    await installInitOnboardingApiMock(page);

    await page.goto('/init');

    await expect(page.getByRole('heading', { name: 'Choose how to start' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Configure Monad Runtime/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Configure Monad Mesh/ })).toBeVisible();

    await page.getByRole('button', { name: /Configure Monad Runtime/ }).click();
    await expect(page.getByRole('heading', { name: 'Connect model providers' })).toBeVisible();
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page).toHaveURL(/\/$/);

    await page.goto('/init');
    await page.getByRole('button', { name: /Configure Monad Mesh/ }).click();
    await expect(page.getByRole('heading', { name: 'Connect external agents' })).toBeVisible();
    await expect(page.getByText('Codex', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('incomplete runtime redirects disabled runtime tabs to overview while Mesh remains available', async ({
    page
  }) => {
    await installInitOnboardingApiMock(page);

    await page.goto('/studio/models');

    await expect(page).toHaveURL(/\/studio\/runtime$/);
    await expect(page.getByRole('heading', { name: 'Runtime overview' })).toBeVisible();

    await page.goto('/studio/nativeCliAgents');

    await expect(page).toHaveURL(/\/studio\/nativeCliAgents$/);
    await expect(page.getByText('Codex', { exact: true })).toBeVisible();
  });
});
