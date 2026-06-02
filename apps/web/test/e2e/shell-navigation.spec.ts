import { expect, type Page, test } from '@playwright/test';

import { API_ROUTE_PATTERN } from './api-route-pattern';

const PROJECT_ID = 'prj_mock00000000';
const SESSION_ID = 'ses_mock00000001';
const CREATED_SESSION_ID = 'ses_123456789012';
const SESSION = {
  id: SESSION_ID,
  title: 'First session',
  projectId: PROJECT_ID,
  createdAt: '2026-07-03T00:00:00.000Z',
  updatedAt: '2026-07-03T00:00:00.000Z',
  origin: { surface: 'http', client: 'web', writableBy: 'anyone' }
};
const CREATED_SESSION = {
  ...SESSION,
  id: CREATED_SESSION_ID,
  projectId: undefined,
  title: 'New chat'
};

function json(body: unknown, status = 200) {
  return { body: JSON.stringify(body), contentType: 'application/json', status };
}

// Minimal daemon surface so the shell renders a workspace with one project that
// owns one session. Every unmatched daemon call resolves to {} so no request wedges
// the app; navigation is what these tests exercise, not data fidelity.
async function installShellMock(page: Page, sentMessages: unknown[] = []) {
  let createdSession = false;
  // Headless defaults to reduced motion, which makes the settings-close take the instant
  // path (no animation, no trailing scrollend) and hides the pager bounce bug. Force motion.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // The TanStack Router Devtools trigger (bottom-left) intercepts pointer events and makes
  // clicks flaky in tests; hide it before app scripts run.
  await page.addInitScript(() => {
    const style = document.createElement('style');
    style.textContent =
      '[aria-label="Open TanStack Router Devtools"], .tsqd-parent-container { display: none !important; pointer-events: none !important; }';
    document.documentElement.appendChild(style);
  });
  await page.route(API_ROUTE_PATTERN, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!(url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/') || url.pathname === '/health')) {
      return route.continue();
    }
    const path = url.pathname.replace('/api/v1', '/v1').replace('/api/health', '/health');
    const method = request.method();

    if (method === 'GET' && path === '/health') {
      return route.fulfill(json({ status: 'ok', version: '0.1.1' }));
    }
    if (method === 'GET' && path === '/v1/init/status') {
      return route.fulfill(json({ initialized: true, missing: [], homePath: '/tmp/monad-e2e-home' }));
    }
    if (method === 'GET' && path === '/v1/settings/locale') return route.fulfill(json({ locale: 'en' }));
    if (method === 'GET' && path === '/v1/settings/locales') {
      return route.fulfill(json({ locales: [{ locale: 'en', label: 'English', source: 'built-in' }] }));
    }
    if (method === 'GET' && path === '/v1/i18n/catalog') return route.fulfill(json({ locale: 'en', messages: {} }));
    if (method === 'GET' && path === '/v1/commands') return route.fulfill(json({ commands: [] }));
    if (method === 'GET' && path === '/v1/agents') return route.fulfill(json({ agents: [] }));
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
    if (method === 'GET' && path === '/v1/settings/model/roles') return route.fulfill(json({ roles: {} }));
    if (method === 'GET' && path === '/v1/settings/network') {
      return route.fulfill(
        json({
          host: '127.0.0.1',
          port: 52522,
          transport: 'uds',
          https: { enabled: false },
          localHttpFallback: { enabled: true },
          remoteAccess: { enabled: false, tokenRevision: 0, token: null }
        })
      );
    }
    if (method === 'GET' && path === '/v1/mesh/agents') return route.fulfill(json({ agents: [] }));
    if (method === 'GET' && path === '/v1/mesh/agents/presets') {
      return route.fulfill(json({ presets: [] }));
    }
    if (method === 'GET' && path === '/v1/sessions') {
      return route.fulfill(
        json({
          sessions: createdSession ? [SESSION, CREATED_SESSION] : [SESSION],
          total: createdSession ? 2 : 1,
          limit: 50,
          offset: 0
        })
      );
    }
    if (method === 'GET' && path === '/v1/sessions/attention') {
      return route.fulfill(json({ summaries: [] }));
    }
    if (method === 'POST' && path === '/v1/sessions') {
      createdSession = true;
      return route.fulfill(json({ sessionId: CREATED_SESSION_ID }));
    }
    if (method === 'POST' && path === `/v1/sessions/${CREATED_SESSION_ID}/messages`) {
      sentMessages.push(request.postDataJSON());
      return route.fulfill(json({ accepted: true }));
    }
    // The project's own session list — arms useProject's active session (and thus the
    // reverse-sync effect the bounce test exercises).
    if (method === 'GET' && /^\/v1\/projects\/[^/]+\/sessions$/.test(path)) {
      return route.fulfill(json({ sessions: [SESSION], total: 1, limit: 50, offset: 0 }));
    }
    if (method === 'GET' && path === '/v1/workplace/projects') {
      return route.fulfill(
        json({
          projects: [
            {
              archived: false,
              createdAt: '2026-07-03T00:00:00.000Z',
              cwd: '/tmp/mock-workplace',
              id: PROJECT_ID,
              state: 'active',
              title: 'Mock Workplace',
              updatedAt: '2026-07-03T00:00:00.000Z'
            }
          ],
          total: 1,
          limit: 50,
          offset: 0,
          orderRevision: 0
        })
      );
    }
    return route.fulfill(json({}));
  });
}

async function openDaemonMenu(page: Page) {
  await page.getByTestId('daemon-menu-trigger').focus();
  await page.keyboard.press('Enter');
  // The subsequent menuitem click auto-waits for the portal, so no separate
  // menu-visible gate is needed (it only added flakiness on the first cold compile).
}

test.describe('Shell navigation', () => {
  test('daemon menu Studio tile starts at Mesh and remembers the last section in memory', async ({ page }) => {
    await installShellMock(page);
    await page.goto('/');

    await openDaemonMenu(page);
    await page.getByRole('menuitem', { name: 'Studio' }).click();
    await expect(page).toHaveURL(/\/studio\/mesh$/);

    await page.getByRole('link', { name: 'Models and providers' }).click();
    await expect(page).toHaveURL(/\/studio\/models$/);

    await openDaemonMenu(page);
    await page.getByRole('menuitem', { name: 'Workspace' }).click();
    await expect(page).toHaveURL(/\/$/);

    await openDaemonMenu(page);
    await page.getByRole('menuitem', { name: 'Studio' }).click();
    await expect(page).toHaveURL(/\/studio\/models$/);

    await page.goto('/');
    await openDaemonMenu(page);
    await page.getByRole('menuitem', { name: 'Studio' }).click();
    await expect(page).toHaveURL(/\/studio\/mesh$/);
  });

  test('new chat sends a file without requiring text', async ({ page }) => {
    const sentMessages: unknown[] = [];
    await installShellMock(page, sentMessages);
    await page.goto('/');

    await page.locator('input[type="file"]').setInputFiles({
      name: 'bundle.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from('zip')
    });
    await expect(page.getByText('bundle.zip')).toBeVisible();

    await page.getByRole('button', { name: 'Send message' }).click();

    await expect.poll(() => sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      attachments: [
        {
          kind: 'file',
          mediaType: 'application/zip',
          name: 'bundle.zip',
          size: 3
        }
      ],
      text: ''
    });
  });

  test('new chat keeps an image preview after the draft session is replaced', async ({ page }) => {
    const sentMessages: unknown[] = [];
    await installShellMock(page, sentMessages);
    await page.goto('/');

    await page.locator('input[type="file"]').setInputFiles({
      name: 'preview.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XzXrAAAAAElFTkSuQmCC',
        'base64'
      )
    });
    await expect(page.getByText('preview.png')).toBeVisible();

    await page.getByRole('button', { name: 'Send message' }).click();

    await expect.poll(() => sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      attachments: [{ kind: 'image', mediaType: 'image/png', name: 'preview.png' }]
    });
    await expect(page).toHaveURL(new RegExp(`/sessions/${CREATED_SESSION_ID}$`));
    await expect(page.getByRole('log').getByText('preview.png')).toBeVisible();
    await expect(page.getByRole('log').locator('img[src^="data:image/png;base64,"]')).toBeVisible();
  });

  test('daemon menu Workspace tile remembers the last route in memory only', async ({ page }) => {
    await installShellMock(page);
    await page.goto(`/workspace/${PROJECT_ID}`);

    await openDaemonMenu(page);
    await page.getByRole('menuitem', { name: 'Studio' }).click();
    await expect(page).toHaveURL(/\/studio\/mesh$/);

    await openDaemonMenu(page);
    await page.getByRole('menuitem', { name: 'Workspace' }).click();
    await expect(page).toHaveURL(new RegExp(`/workspace/${PROJECT_ID}$`));

    await page.goto('/studio/runtime');
    await openDaemonMenu(page);
    await page.getByRole('menuitem', { name: 'Workspace' }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('daemon menu Settings button opens settings', async ({ page }) => {
    await installShellMock(page);
    await page.goto('/');

    await openDaemonMenu(page);
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/settings(\/|$)/);
  });

  test('an active project reveals its sessions and a session click routes to it', async ({ page }) => {
    await installShellMock(page);
    await page.goto(`/workspace/${PROJECT_ID}`);

    const expandAll = page.getByRole('button', { name: 'Expand all projects' });
    if (await expandAll.isVisible()) await expandAll.click();
    const sessionLink = page.getByRole('link', { name: 'First session' });
    await expect(sessionLink).toBeVisible();
    await sessionLink.click();
    await expect(page).toHaveURL(new RegExp(`/workspace/${PROJECT_ID}/${SESSION_ID}`));
  });

  // Regression for the reverse-sync URL bounce (navigation.ts): on a project-session route
  // the active session is armed, so navigating away used to fire the reverse-sync effect with
  // a stale activeProjectSession and replaceUrl the caller straight back — trapping them.
  // Repro for: workspace -> studio -> settings (Cmd+,) -> back should return to studio,
  // not fall through to the last workspace path.
  test('settings opened from studio returns to studio, not the workspace', async ({ page }) => {
    await installShellMock(page);
    await page.goto('/studio/models');
    await expect(page).toHaveURL(/\/studio\/models/);

    await openDaemonMenu(page);
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/settings(\/|$)/);

    // Sidebar Back runs closeSettingsWithPagerAnimation (the buggy path); must return to studio.
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page).toHaveURL(/\/studio\//);
  });
});
