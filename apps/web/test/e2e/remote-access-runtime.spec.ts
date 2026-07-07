import { expect, type Page, test } from '@playwright/test';

function json(body: unknown, status = 200) {
  return {
    body: JSON.stringify(body),
    contentType: 'application/json',
    status
  };
}

async function installRemoteAccessRuntimeMock(page: Page) {
  let probeCalls = 0;
  const networkRuntime = {
    listeners: [{ scheme: 'https', host: '0.0.0.0', port: 52749 }],
    remoteAccess: { enabled: true, tokenRevision: 3 },
    lastAppliedAt: '2026-07-07T00:00:00.000Z'
  };
  const networkSettings = {
    host: '127.0.0.1',
    port: 52749,
    transport: 'uds',
    https: { enabled: true },
    remoteAccess: { enabled: true, token: 'secret' },
    localHttpFallback: { enabled: false, port: 52780 },
    remoteUrls: [
      { kind: 'lan', label: 'LAN', url: 'https://172.16.112.210:52749' },
      { kind: 'overlay', label: 'Tailscale', url: 'https://100.64.1.2:52749' }
    ],
    restartRequired: false,
    runtime: networkRuntime
  };

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!(url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/') || url.pathname === '/health')) {
      return route.continue();
    }

    const path = url.pathname.replace('/api/v1', '/v1').replace('/api/health', '/health');
    const method = request.method();

    if (method === 'GET' && path === '/health') {
      return route.fulfill(json({ status: 'ok', version: '0.1.1', networkRuntime }));
    }
    if (method === 'GET' && path === '/v1/settings/network') return route.fulfill(json(networkSettings));
    if (method === 'POST' && path === '/v1/settings/network/probe') {
      probeCalls += 1;
      return route.fulfill(json({ ok: true, status: 200, latencyMs: 12 }));
    }
    if (method === 'GET' && path === '/v1/init/status') {
      return route.fulfill(json({ initialized: true, missing: [], homePath: '/tmp/monad-e2e-home' }));
    }
    if (method === 'GET' && path === '/v1/sessions')
      return route.fulfill(json({ sessions: [], total: 0, limit: 50, offset: 0 }));
    if (method === 'GET' && path === '/v1/projects')
      return route.fulfill(json({ projects: [], total: 0, limit: 50, offset: 0 }));
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
    if (method === 'GET' && path === '/v1/i18n/catalog') return route.fulfill(json({ locale: 'en', messages: {} }));
    if (method === 'GET' && path === '/v1/settings/developer') {
      return route.fulfill(json({ developerMode: false, logsDir: '/tmp/monad-e2e-home/logs' }));
    }
    if (method === 'GET' && path === '/v1/settings/startup')
      return route.fulfill(json({ enabled: false, supported: true }));
    if (method === 'GET' && path === '/v1/system/upgrade') {
      return route.fulfill(
        json({ available: false, currentVersion: '0.1.1', latestVersion: null, stage: 'idle', progress: 0 })
      );
    }
    if (method === 'GET' && path === '/v1/settings/tool-backends') {
      return route.fulfill(
        json({
          codeExec: { availableBackends: ['follow-system'], backend: 'follow-system' },
          email: { backend: 'auto' },
          webSearch: { provider: 'auto' }
        })
      );
    }
    if (method === 'GET' && path === '/v1/settings/browser-preset') {
      return route.fulfill(json({ enabled: false, headless: true, vision: false }));
    }
    if (method === 'GET' && path === '/v1/settings/computer-preset') {
      return route.fulfill(json({ args: [], command: 'computer-use', enabled: false }));
    }
    if (method === 'GET' && path === '/v1/settings/obscura') {
      return route.fulfill(json({ connected: false, enabled: false, installed: false, stealth: false, tools: [] }));
    }
    if (method === 'GET' && path === '/v1/settings/mcp-servers') return route.fulfill(json({ servers: [] }));
    if (method === 'GET' && path === '/v1/settings/mcp-servers/status') return route.fulfill(json({ servers: [] }));
    if (method === 'GET' && path === '/v1/settings/mcp-servers/catalog') return route.fulfill(json({ entries: [] }));
    if (method === 'GET' && path === '/v1/atoms/mcp') return route.fulfill(json({ servers: [] }));
    if (method === 'POST' && path === '/v1/usage/reset') return route.fulfill(json({ ok: true }));
    if (method === 'DELETE' && path.startsWith('/v1/sessions/')) return route.fulfill(json({ ok: true }));

    return route.fulfill(json({}));
  });

  return { probeCalls: () => probeCalls };
}

test('daemon item shows remote runtime details on hover', async ({ page }) => {
  await installRemoteAccessRuntimeMock(page);
  await page.goto('/');

  await page.getByTestId('daemon-runtime-status').hover();

  await expect(page.getByText('Daemon network runtime').first()).toBeVisible();
  await expect(page.getByText('https://0.0.0.0:52749').first()).toBeVisible();
  await expect(page.getByText('Token revision 3').first()).toBeVisible();
});

test('system settings shows remote URLs and probes them', async ({ page }) => {
  const api = await installRemoteAccessRuntimeMock(page);
  await page.goto('/studio/capabilities?settings=system');

  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('https://172.16.112.210:52749')).toBeVisible();
  await expect(page.getByText('https://100.64.1.2:52749')).toBeVisible();
  await expect(page.getByText('Token revision 3')).toBeVisible();

  await page.getByRole('button', { name: 'Check' }).first().click();

  await expect.poll(api.probeCalls).toBe(1);
  await expect(page.getByText('12 ms')).toBeVisible();
});
