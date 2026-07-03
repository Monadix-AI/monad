import { expect, type Page, test } from '@playwright/test';

const projectId = 'prj_mock';

function json(body: unknown, status = 200) {
  return {
    body: JSON.stringify(body),
    contentType: 'application/json',
    status
  };
}

function sse(event: unknown) {
  return {
    body: `data: ${JSON.stringify(event)}\n\n`,
    contentType: 'text/event-stream',
    headers: {
      'cache-control': 'no-cache'
    }
  };
}

const mockExperienceModule = `
class MockCanvas extends HTMLElement {
  connectedCallback() {
    this.style.padding = '24px';
    this.style.display = 'block';
    this.render();
    this.addEventListener('monad-workspace-experience:update', () => this.render());
  }

  async render() {
    const host = this.monadWorkspaceExperience;
    if (!host) {
      this.textContent = 'mock canvas waiting for host';
      return;
    }
    this.dataset.hostProjectId = host.snapshot.projectId;
    this.dataset.embedded = String(host.embedded);
    if (this.dataset.apiResult) {
      this.textContent = 'mock canvas mounted for ' + host.snapshot.projectId + ' via ' + this.dataset.apiResult;
      return;
    }
    this.textContent = 'mock canvas mounted for ' + host.snapshot.projectId;
    if (this.dataset.calledApi) return;
    this.dataset.calledApi = 'true';
    const response = await fetch('/api/v1/atoms/workspace-experiences/mock-canvas/api/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: host.snapshot.projectId })
    });
    const body = await response.json();
    this.dataset.apiResult = body.result;
    this.textContent = 'mock canvas mounted for ' + host.snapshot.projectId + ' via ' + body.result;
  }
}

customElements.define('mock-canvas', MockCanvas);
`;

async function mockWorkplaceApi(page: Page) {
  await page.route('**/v1/atoms/mock-experience/assets/dist/mock-canvas.js', (route) =>
    route.fulfill({
      body: mockExperienceModule,
      contentType: 'text/javascript',
      status: 200
    })
  );

  await page.route('**/api/health', (route) =>
    route.fulfill(json({ status: 'ok', version: '0.1.1', latestVersion: '0.1.1' }))
  );

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, '');
    const method = request.method();

    if (method === 'GET' && path === '/v1/init/status') return route.fulfill(json({ initialized: true }));
    if (method === 'GET' && path === '/v1/settings/locale') return route.fulfill(json({ locale: 'en' }));
    if (method === 'GET' && path === '/v1/i18n/catalog') return route.fulfill(json({ locale: 'en', messages: {} }));
    if (method === 'GET' && path === '/v1/sessions') {
      return route.fulfill(json({ sessions: [], total: 0, hasMore: false }));
    }
    if (method === 'GET' && path === '/v1/workplace/projects') {
      return route.fulfill(
        json({
          projects: [
            {
              archived: false,
              createdAt: '2026-07-03T00:00:00.000Z',
              cwd: '/tmp/mock-workplace',
              id: projectId,
              ownerPrincipalId: 'pri_mock',
              state: 'ready',
              title: 'Mock Project',
              updatedAt: '2026-07-03T00:00:00.000Z'
            }
          ],
          total: 1,
          hasMore: false
        })
      );
    }
    if (method === 'GET' && path === '/v1/commands') return route.fulfill(json({ commands: [] }));
    if (method === 'GET' && path === '/v1/settings/model/profiles') {
      return route.fulfill(
        json({
          defaultAlias: 'default',
          profiles: [
            {
              alias: 'default',
              fallbacks: [],
              params: {},
              routes: { chat: { provider: 'mock-provider', modelId: 'mock-model' } }
            }
          ]
        })
      );
    }
    if (method === 'GET' && path === '/v1/settings/model/roles') return route.fulfill(json({ roles: {} }));
    if (method === 'GET' && path === '/v1/settings/profile') {
      return route.fulfill(json({ displayName: 'Zeke' }));
    }
    if (method === 'GET' && path === '/v1/settings/acp-agents') return route.fulfill(json({ agents: [] }));
    if (method === 'GET' && path === '/v1/settings/acp-agents/presets') return route.fulfill(json({ presets: [] }));
    if (method === 'GET' && path === '/v1/settings/native-cli-agents') return route.fulfill(json({ agents: [] }));
    if (method === 'GET' && path === '/v1/settings/native-cli-agents/presets') {
      return route.fulfill(json({ presets: [] }));
    }
    if (method === 'GET' && path === `/v1/projects/${projectId}/native-cli-sessions`) {
      return route.fulfill(json({ sessions: [] }));
    }
    if (method === 'GET' && path === `/v1/projects/${projectId}/ui-stream`) {
      return route.fulfill(sse({ kind: 'snapshot', items: [], hasMore: false }));
    }
    if (method === 'GET' && path === '/v1/atoms/workspace-experiences') {
      return route.fulfill(
        json({
          experiences: [
            {
              api: { routes: [{ method: 'POST', path: '/search' }] },
              entry: {
                module: '/v1/atoms/mock-experience/assets/dist/mock-canvas.js',
                tagName: 'mock-canvas',
                type: 'web-component'
              },
              id: 'mock-canvas',
              title: 'Mock Canvas'
            }
          ]
        })
      );
    }
    if (method === 'POST' && path === '/v1/atoms/workspace-experiences/mock-canvas/api/search') {
      const body = request.postDataJSON() as { query?: string };
      return route.fulfill(json({ result: `api:${body.query ?? 'missing'}` }));
    }

    return route.fulfill(json({ error: `Unhandled ${method} ${path}` }, 404));
  });
}

test.describe('workspace experience atoms', () => {
  test('mounts a mock experience as a whole workplace region and lets it call its API', async ({ page }) => {
    await mockWorkplaceApi(page);

    await page.goto(`/workplace/projects/${projectId}`);
    await expect(page.locator('.project-topbar-name', { hasText: 'Mock Project' })).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: 'Project view mode' }).click();
    await page.getByRole('menuitem', { name: 'Mock Canvas' }).click();

    const canvas = page.locator('mock-canvas');
    await expect(canvas).toBeVisible();
    await expect(canvas).toHaveAttribute('data-experience-id', 'mock-canvas');
    await expect(canvas).toHaveAttribute('data-host-project-id', projectId);
    await expect(canvas).toHaveAttribute('data-embedded', 'true');
    await expect(canvas).toHaveAttribute('data-api-result', `api:${projectId}`);
    await expect(canvas).toContainText(`mock canvas mounted for ${projectId} via api:${projectId}`);
  });
});
