import { expect, type Page, test } from '@playwright/test';

async function installCapabilitiesApiMock(page: Page) {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!(url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/') || url.pathname === '/health')) {
      return route.continue();
    }

    const path = url.pathname.replace('/api/v1', '/v1').replace('/api/health', '/health');
    const method = request.method();
    const json = (payload: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(payload)
      });

    if (method === 'GET' && path === '/health') return json({ status: 'ok', version: '0.1.1', warnings: [] });
    if (method === 'GET' && path === '/v1/init/status') {
      return json({ initialized: true, missing: [], homePath: '/tmp/monad-e2e-home' });
    }
    if (method === 'GET' && path === '/v1/sessions') {
      return json({ sessions: [], total: 0, limit: 50, offset: 0 });
    }
    if (method === 'GET' && path === '/v1/commands') return json({ commands: [] });
    if (method === 'GET' && path === '/v1/settings/model/profiles') {
      return json({ profiles: [], defaultAlias: '' });
    }
    if (method === 'GET' && path === '/v1/settings/locale') return json({ locale: 'en' });
    if (method === 'GET' && path === '/v1/settings/locales') {
      return json({ locales: [{ locale: 'en', label: 'English', source: 'built-in' }] });
    }
    if (method === 'GET' && path === '/v1/i18n/catalog') return json({ locale: 'en', messages: {} });

    if (method === 'GET' && path === '/v1/settings/tool-backends') {
      return json({
        webSearch: { provider: 'auto' },
        email: { backend: 'auto' },
        codeExec: { backend: 'follow-system', availableBackends: ['follow-system', 'docker', 'e2b'] }
      });
    }
    if (method === 'GET' && path === '/v1/settings/browser-preset') {
      return json({ enabled: false, headless: true, vision: false });
    }
    if (method === 'GET' && path === '/v1/settings/computer-preset') {
      return json({ enabled: false, command: 'computer-use', args: [] });
    }
    if (method === 'GET' && path === '/v1/settings/obscura') {
      return json({ enabled: false, stealth: false, installed: false, connected: false, tools: [] });
    }
    if (method === 'GET' && path === '/v1/settings/mcp-servers') {
      return json({
        servers: Array.from({ length: 8 }, (_, index) => ({
          name: `config-server-${index + 1}`,
          transport: 'stdio',
          command: 'npx',
          args: [`server-${index + 1}`],
          enabled: true,
          trust: { autoApproveTools: [] }
        }))
      });
    }
    if (method === 'GET' && path === '/v1/settings/mcp-servers/status') {
      return json({
        servers: Array.from({ length: 8 }, (_, index) => ({
          name: `config-server-${index + 1}`,
          source: 'config',
          transport: 'stdio',
          state: 'connected',
          toolCount: 2,
          tools: ['search', 'read']
        }))
      });
    }
    if (method === 'GET' && path === '/v1/settings/mcp-servers/catalog') {
      return json({ entries: [] });
    }
    if (method === 'GET' && path === '/v1/atoms/mcp') {
      return json({
        servers: Array.from({ length: 8 }, (_, index) => ({
          name: `atom-server-${index + 1}`,
          transport: 'stdio',
          command: 'uvx',
          enabled: true
        }))
      });
    }

    return json({});
  });
}

test('Studio capabilities content scrolls within the panel', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  await installCapabilitiesApiMock(page);

  await page.goto('/studio/capabilities');
  await expect(page.getByRole('heading', { name: 'Capabilities', exact: true })).toBeVisible();
  await expect(page.getByText('atom-server-8')).toBeVisible();
  await expect
    .poll(async () =>
      page.locator('section').evaluateAll((sections) => {
        const toolsSection = sections
          .filter((section) =>
            Array.from(section.querySelectorAll('p')).some((node) => node.textContent?.trim() === 'Tools')
          )
          .sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0))[0];
        return toolsSection?.textContent ?? '';
      })
    )
    .not.toMatch(/Browser \(Playwright\)|Computer Use|Obscura/);

  const viewport = page.locator('[data-slot="scroll-area-viewport"]').first();
  await expect
    .poll(async () =>
      viewport.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight
      }))
    )
    .toMatchObject({ clientHeight: expect.any(Number), scrollHeight: expect.any(Number) });

  await expect.poll(async () => viewport.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });

  await expect.poll(async () => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});

test('settings modal opens from canonical Studio routes', async ({ page }) => {
  await installCapabilitiesApiMock(page);

  await page.goto('/studio/capabilities?settings=language');
  await expect(page).toHaveURL(/\/studio\/capabilities\?settings=language$/);
  await expect(page.locator('[role="dialog"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Language' })).toHaveAttribute('data-active', 'true');

  await page.getByRole('button', { name: 'Connection' }).click();
  await expect(page).toHaveURL(/\/studio\/capabilities\?settings=connection$/);
});
