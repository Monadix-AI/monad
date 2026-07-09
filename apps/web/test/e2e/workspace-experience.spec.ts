import type { Session } from '@monad/protocol';

import { expect, type Page, test } from '@playwright/test';

const projectId = 'prj_ABCDEF123456';
const projectRouteId = projectId;
const alphaSessionId = 'ses_ALPHA1234567';
const alphaSessionRouteId = alphaSessionId;
const betaSessionId = 'ses_BETA12345678';
const betaSessionRouteId = betaSessionId;

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
    this.dataset.apiBaseUrl = host.apiBaseUrl || '';
    if (this.dataset.apiResult) {
      this.textContent = 'mock canvas mounted for ' + host.snapshot.projectId + ' via ' + this.dataset.apiResult;
      return;
    }
    this.textContent = 'mock canvas mounted for ' + host.snapshot.projectId;
    if (this.dataset.calledApi) return;
    this.dataset.calledApi = 'true';
    const response = await fetch(host.apiBaseUrl + '/search', {
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

const mockCanvasExperience = {
  api: { routes: [{ method: 'POST', path: '/search' }] },
  entry: {
    module: '/v1/atoms/mock-experience/assets/dist/mock-canvas.js',
    tagName: 'mock-canvas',
    type: 'web-component'
  },
  id: 'mock-canvas',
  title: 'Mock Canvas'
};

// The real first-party graph-view: shipped as a web-component whose module is served same-origin by
// the web app itself (public/experiences/graph-view.js) — NOT mocked here, so the test exercises the
// actual shipping module. chat-room stays a host-component, mirroring production.
const graphViewExperience = {
  entry: { module: '/experiences/graph-view.js', tagName: 'monad-graph-view', type: 'web-component' },
  icon: 'git-fork',
  id: 'graphic-view',
  title: 'Activity'
};
const chatRoomExperience = {
  entry: { component: 'chat-room', type: 'host-component' },
  icon: 'message-square',
  id: 'chat-room',
  title: 'Chat'
};

async function mockWorkplaceApi(
  page: Page,
  experiences: unknown[] = [mockCanvasExperience],
  options: {
    sessions?: Session[];
    sendProjectMessage?: (request: { text?: string; attempt: number }) => { status?: number; body?: unknown };
  } = {}
) {
  let sendProjectMessageAttempts = 0;
  const sessions = options.sessions ?? [projectSession(alphaSessionId, 'Alpha session', '2026-07-04T00:00:00.000Z')];

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
      return route.fulfill(json({ sessions, total: sessions.length, hasMore: false }));
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
    if (method === 'GET' && path === '/v1/settings/external-agents') return route.fulfill(json({ agents: [] }));
    if (method === 'GET' && path === '/v1/settings/external-agents/presets') {
      return route.fulfill(json({ presets: [] }));
    }
    if (method === 'GET' && path === `/v1/projects/${projectId}/external-agent-sessions`) {
      return route.fulfill(json({ sessions: [] }));
    }
    if (method === 'GET' && path === `/v1/projects/${projectId}/sessions`) {
      return route.fulfill(json({ sessions: sessions.filter((session) => session.projectId === projectId) }));
    }
    if (method === 'POST' && path === `/v1/projects/${projectId}/sessions`) {
      return route.fulfill(json({ sessionId: alphaSessionId }, 201));
    }
    const sessionExternalAgentMatch = path.match(/^\/v1\/sessions\/([^/]+)\/external-agent-sessions$/);
    if (method === 'GET' && sessionExternalAgentMatch) {
      return route.fulfill(json({ sessions: [] }));
    }
    if (method === 'GET' && path === `/v1/projects/${projectId}/ui-stream`) {
      return route.fulfill(sse({ kind: 'snapshot', items: [], hasMore: false }));
    }
    if (method === 'POST' && path === `/v1/projects/${projectId}/messages`) {
      sendProjectMessageAttempts += 1;
      const body = request.postDataJSON() as { text?: string };
      const result = options.sendProjectMessage?.({ text: body.text, attempt: sendProjectMessageAttempts }) ?? {};
      return route.fulfill(json(result.body ?? { accepted: true }, result.status ?? 200));
    }
    if (method === 'GET' && path === '/v1/atoms/workspace-experiences') {
      return route.fulfill(json({ experiences }));
    }
    if (method === 'POST' && path === '/v1/atoms/workspace-experiences/mock-canvas/api/search') {
      const body = request.postDataJSON() as { query?: string };
      return route.fulfill(json({ result: `api:${body.query ?? 'missing'}` }));
    }

    return route.fulfill(json({ error: `Unhandled ${method} ${path}` }, 404));
  });
}

function projectSession(id: string, title: string, updatedAt: string): Session {
  return {
    id: id as Session['id'],
    projectId: projectId as Session['projectId'],
    title,
    ownerPrincipalId: 'prn_mock00000000' as Session['ownerPrincipalId'],
    state: 'active',
    agentIds: [],
    parentSessionId: null,
    archived: false,
    restoreCount: 0,
    createdAt: updatedAt,
    updatedAt
  };
}

test.describe('workspace experience atoms', () => {
  test('mounts a mock experience as a whole workplace region and lets it call its API', async ({ page }) => {
    await mockWorkplaceApi(page);

    await page.goto(`/workspace/${projectRouteId}/${alphaSessionRouteId}`);
    await expect(page.locator('.project-topbar-name', { hasText: 'Mock Project' })).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: 'Project view mode' }).click();
    await page.getByRole('menuitem', { name: 'Mock Canvas' }).click();

    const canvas = page.locator('mock-canvas');
    await expect(canvas).toBeVisible();
    await expect(canvas).toHaveAttribute('data-experience-id', 'mock-canvas');
    await expect(canvas).toHaveAttribute('data-host-project-id', projectId);
    await expect(canvas).toHaveAttribute('data-embedded', 'true');
    await expect(canvas).toHaveAttribute('data-api-base-url', '/api/v1/atoms/workspace-experiences/mock-canvas/api');
    await expect(canvas).toHaveAttribute('data-api-result', `api:${projectId}`);
    await expect(canvas).toContainText(`mock canvas mounted for ${projectId} via api:${projectId}`);
  });

  test('ships the first-party graph-view over the web-component path and dogfoods its host actions', async ({
    page
  }) => {
    // graph-view is first in the list, so it is the default view — its real shipping module
    // (public/experiences/graph-view.js) mounts on load, no mock module involved.
    await mockWorkplaceApi(page, [graphViewExperience, chatRoomExperience]);

    await page.goto(`/workspace/${projectRouteId}/${alphaSessionRouteId}`);
    await expect(page.locator('.project-topbar-name', { hasText: 'Mock Project' })).toBeVisible({ timeout: 20_000 });

    const graph = page.locator('monad-graph-view');
    await expect(graph).toBeVisible();
    await expect(graph).toHaveAttribute('data-experience-id', 'graphic-view');
    // Rendered from the published host snapshot delivered over the event bridge.
    await expect(graph).toHaveAttribute('data-ready', 'true');
    await expect(graph).toHaveAttribute('data-project-id', projectId);
    // The hub node always renders; participant/activity counts come off snapshot.graphCanvas.
    await expect(graph).toContainText('monad');
    await expect(graph).toHaveAttribute('data-participant-count', /\d+/);

    // Clicking the hub dogfoods api.actions.switchExperience — a real switch to the chat-room
    // experience, which unmounts the graph.
    await graph.locator('[data-node-id="hub:monad"]').click();
    await expect(graph).toBeHidden();
    await expect(page.locator('[contenteditable][aria-label="Message agents"]')).toBeVisible();

    const chatLayout = await page.evaluate(() => {
      const editor = document.querySelector('[contenteditable][aria-label="Message agents"]');
      const composer = editor?.closest('.absolute.right-0.bottom-0.left-0.z-20');
      const transcript = document.querySelector<HTMLElement>('[style*="--chat-room-composer-clearance"]');
      const scroll = transcript?.querySelector<HTMLElement>('.scwf-scroll');
      const composerRect = composer?.getBoundingClientRect();
      const transcriptRect = transcript?.getBoundingClientRect();
      const scrollPaddingBottom = scroll ? Number.parseFloat(getComputedStyle(scroll).paddingBottom) : 0;
      if (!composerRect || !transcriptRect) {
        return {
          composerHeight: composerRect?.height ?? 0,
          composerIsOverlay: composer ? getComputedStyle(composer).position === 'absolute' : false,
          composerOverlapsTranscript: false,
          scrollPaddingBottom,
          transcriptReachesBottom: false
        };
      }
      return {
        composerHeight: composerRect.height,
        composerIsOverlay: composer ? getComputedStyle(composer).position === 'absolute' : false,
        composerOverlapsTranscript:
          composerRect.top < transcriptRect.bottom && composerRect.bottom >= transcriptRect.bottom - 1,
        scrollPaddingBottom,
        transcriptReachesBottom: Math.abs(transcriptRect.bottom - composerRect.bottom) <= 1
      };
    });

    expect(chatLayout.composerIsOverlay).toBe(true);
    expect(chatLayout.transcriptReachesBottom).toBe(true);
    expect(chatLayout.composerOverlapsTranscript).toBe(true);
    expect(chatLayout.scrollPaddingBottom).toBeGreaterThan(chatLayout.composerHeight);

    // And the host menu can switch back to Activity, re-mounting the same web-component.
    await page.getByRole('button', { name: 'Project view mode' }).click();
    await page.getByRole('menuitem', { name: 'Activity' }).click();
    await expect(page.locator('monad-graph-view')).toBeVisible();
  });

  test('switches the active experience with the selected project session', async ({ page }) => {
    await mockWorkplaceApi(page, [graphViewExperience, mockCanvasExperience], {
      sessions: [
        projectSession(alphaSessionId, 'Alpha session', '2026-07-04T00:00:00.000Z'),
        projectSession(betaSessionId, 'Beta session', '2026-07-03T00:00:00.000Z')
      ]
    });

    await page.goto(`/workspace/${projectRouteId}/${alphaSessionRouteId}`);
    await expect(page.locator('.project-topbar-name', { hasText: 'Mock Project' })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.project-topbar-name', { hasText: 'Alpha session' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/workspace/${projectRouteId}/${alphaSessionRouteId}$`));
    await expect(page.locator('monad-graph-view')).toBeVisible();

    await page.getByRole('button', { name: 'Project view mode' }).click();
    await page.getByRole('menuitem', { name: 'Mock Canvas' }).click();
    await expect(page.locator('mock-canvas')).toBeVisible();

    await page.getByRole('treeitem', { name: 'Beta session' }).click();

    await expect(page).toHaveURL(new RegExp(`/workspace/${projectRouteId}/${betaSessionRouteId}$`));
    await expect(page.locator('.project-topbar-name', { hasText: 'Beta session' })).toBeVisible();
    await expect(page.locator('monad-graph-view')).toBeVisible();
    await expect(page.locator('mock-canvas')).toBeHidden();

    await page.getByRole('treeitem', { name: 'Alpha session' }).click();

    await expect(page).toHaveURL(new RegExp(`/workspace/${projectRouteId}/${alphaSessionRouteId}$`));
    await expect(page.locator('.project-topbar-name', { hasText: 'Alpha session' })).toBeVisible();
    await expect(page.locator('mock-canvas')).toBeVisible();
    await expect(page.locator('monad-graph-view')).toBeHidden();
  });

  test('shows retry affordance for failed optimistic project messages', async ({ page }) => {
    const attempts: Array<{ text?: string; attempt: number }> = [];
    await mockWorkplaceApi(page, [chatRoomExperience], {
      sendProjectMessage: (request) => {
        attempts.push(request);
        return request.attempt === 1 ? { status: 500, body: { error: 'send failed' } } : { body: { accepted: true } };
      }
    });

    await page.goto(`/workspace/${projectRouteId}/${alphaSessionRouteId}`);
    await expect(page.locator('.project-topbar-name', { hasText: 'Mock Project' })).toBeVisible({ timeout: 20_000 });

    const editor = page.locator('[contenteditable][aria-label="Message agents"]');
    await editor.fill('hello from optimistic');
    await editor.press('Enter');

    await expect(page.getByText('hello from optimistic')).toBeVisible();
    const outline = page.getByRole('navigation', { name: 'User message outline' });
    await expect(outline).toBeVisible();
    const outlineItem = outline.getByRole('button', { name: /hello from optimistic/ });
    await expect(outlineItem).toBeVisible();
    await outlineItem.hover();
    await expect(
      outline.locator('.chat-message-outline__preview-body', { hasText: 'hello from optimistic' })
    ).toBeVisible();
    await expect(outline.locator('.chat-message-outline__preview-time')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry message' })).toBeVisible();
    await expect(editor).toHaveText('');

    await page.getByRole('button', { name: 'Retry message' }).click();

    await expect(page.getByText('hello from optimistic')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry message' })).toBeHidden();
    expect(attempts).toEqual([
      { text: 'hello from optimistic', attempt: 1 },
      { text: 'hello from optimistic', attempt: 2 }
    ]);
  });
});
