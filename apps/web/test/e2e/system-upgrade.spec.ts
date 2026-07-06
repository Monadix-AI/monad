import { expect, type Page, test } from '@playwright/test';

function json(body: unknown, status = 200) {
  return {
    body: JSON.stringify(body),
    contentType: 'application/json',
    status
  };
}

async function installSystemSettingsApiMock(
  page: Page,
  health: { version: string; latestVersion?: string; latestVersionCheckedAt?: string }
) {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!(url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/') || url.pathname === '/health')) {
      return route.continue();
    }

    const path = url.pathname.replace('/api/v1', '/v1').replace('/api/health', '/health');
    const method = request.method();

    if (method === 'GET' && path === '/health') return route.fulfill(json({ status: 'ok', ...health }));
    if (method === 'GET' && path === '/v1/init/status') {
      return route.fulfill(json({ initialized: true, missing: [], homePath: '/tmp/monad-e2e-home' }));
    }
    if (method === 'GET' && path === '/v1/sessions') {
      return route.fulfill(json({ sessions: [], total: 0, limit: 50, offset: 0 }));
    }
    if (method === 'GET' && path === '/v1/commands') return route.fulfill(json({ commands: [] }));
    if (method === 'GET' && (path === '/v1/native-cli-runtimes' || path === '/v1/native-cli-session-summaries')) {
      return route.fulfill(json({ sessions: [] }));
    }
    if (method === 'GET' && path === '/v1/settings/model/profiles') {
      return route.fulfill(json({ profiles: [], defaultAlias: '' }));
    }
    if (method === 'GET' && path === '/v1/settings/model/roles') return route.fulfill(json({ roles: {} }));
    if (method === 'GET' && path === '/v1/settings/locale') return route.fulfill(json({ locale: 'en' }));
    if (method === 'GET' && path === '/v1/settings/locales') {
      return route.fulfill(json({ locales: [{ locale: 'en', label: 'English', source: 'built-in' }] }));
    }
    if (method === 'GET' && path === '/v1/i18n/catalog') {
      return route.fulfill(json({ locale: 'en', messages: {} }));
    }
    if (method === 'GET' && path === '/v1/settings/developer') {
      return route.fulfill(json({ developerMode: false, logsDir: '/tmp/monad-e2e-home/logs' }));
    }
    if (method === 'GET' && path === '/v1/settings/startup') {
      return route.fulfill(json({ enabled: false, supported: true }));
    }
    if (method === 'GET' && path === '/v1/settings/tool-backends') {
      return route.fulfill(
        json({
          webSearch: { provider: 'auto' },
          email: { backend: 'auto' },
          codeExec: { backend: 'follow-system', availableBackends: ['follow-system'] }
        })
      );
    }
    if (method === 'GET' && path === '/v1/settings/browser-preset') {
      return route.fulfill(json({ enabled: false, headless: true, vision: false }));
    }
    if (method === 'GET' && path === '/v1/settings/computer-preset') {
      return route.fulfill(json({ enabled: false, command: 'computer-use', args: [] }));
    }
    if (method === 'GET' && path === '/v1/settings/obscura') {
      return route.fulfill(json({ enabled: false, stealth: false, installed: false, connected: false, tools: [] }));
    }
    if (method === 'GET' && path === '/v1/settings/mcp-servers') return route.fulfill(json({ servers: [] }));
    if (method === 'GET' && path === '/v1/settings/mcp-servers/status') return route.fulfill(json({ servers: [] }));
    if (method === 'GET' && path === '/v1/settings/mcp-servers/catalog') return route.fulfill(json({ entries: [] }));
    if (method === 'GET' && path === '/v1/atoms/mcp') return route.fulfill(json({ servers: [] }));
    if (method === 'PUT' && (path === '/v1/settings/developer' || path === '/v1/settings/startup')) {
      return route.fulfill(json({ ok: true }));
    }
    if (method === 'POST' && path === '/v1/usage/reset') return route.fulfill(json({ ok: true }));
    if (method === 'DELETE' && path.startsWith('/v1/sessions/')) return route.fulfill(json({ ok: true }));

    return route.fulfill(json({}));
  });
}

test.describe('System upgrade settings', () => {
  test('shows up-to-date state when daemon and latest versions match', async ({ page }) => {
    await installSystemSettingsApiMock(page, { version: '0.1.1', latestVersion: '0.1.1' });

    await page.goto('/studio/capabilities?settings=system');

    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'System' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Up to date')).toBeVisible();
    await expect(page.getByText('monad upgrade')).toHaveCount(0);
  });

  test('shows upgrade command when health reports a newer version', async ({ page }) => {
    await installSystemSettingsApiMock(page, {
      version: '0.1.1',
      latestVersion: '0.2.0',
      latestVersionCheckedAt: '2026-07-01T00:00:00.000Z'
    });

    await page.goto('/studio/capabilities?settings=system');

    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('0.2.0 available')).toBeVisible();
    await expect(page.getByText('monad upgrade')).toBeVisible();
  });
});
