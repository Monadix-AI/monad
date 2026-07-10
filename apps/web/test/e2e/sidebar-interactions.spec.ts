import type { Page } from '@playwright/test';

import { expect, test } from '@playwright/test';

const PROJECT_ID = 'prj_sidebar000001';
const SECOND_PROJECT_ID = 'prj_sidebar000002';
const CHAT_SESSION_ID = 'ses_chat000000001';

type MockProject = {
  archived: boolean;
  createdAt: string;
  cwd?: string;
  id: string;
  ownerPrincipalId: string;
  state: string;
  title: string;
  updatedAt: string;
};

type MockSession = {
  archived: boolean;
  createdAt: string;
  id: string;
  ownerPrincipalId: string;
  projectId?: string | null;
  state: string;
  title: string;
  updatedAt: string;
};

type SidebarMockState = {
  projects: MockProject[];
  sessions: MockSession[];
  updateSessionRequests: Array<{ id: string; title?: string }>;
  updateProjectRequests: Array<{ id: string; title?: string }>;
  deleteSessionRequests: string[];
  createProjectRequests: Array<{ cwd?: string; title: string }>;
  createProjectSessionRequests: Array<{ projectId: string; title?: string }>;
  invalidSessionRequests: Array<{ method: string; path: string; sessionId: string }>;
  sendMessageRequests: Array<{ sessionId: string; text?: string }>;
};

type SidebarMockOptions = {
  createChatSessionGate?: Promise<void>;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function json(body: unknown, status = 200) {
  return { body: JSON.stringify(body), contentType: 'application/json', status };
}

function makeSession(id: string, title: string, index: number, projectId: string | null = PROJECT_ID): MockSession {
  return {
    archived: false,
    createdAt: `2026-07-0${Math.min(index, 9)}T00:00:00.000Z`,
    id,
    ownerPrincipalId: 'prn_mock00000000',
    projectId,
    state: 'active',
    title,
    updatedAt: `2026-07-${String(10 - Math.min(index, 9)).padStart(2, '0')}T00:00:00.000Z`
  };
}

function createSidebarState(): SidebarMockState {
  return {
    createProjectRequests: [],
    createProjectSessionRequests: [],
    deleteSessionRequests: [],
    invalidSessionRequests: [],
    projects: [
      {
        archived: false,
        createdAt: '2026-07-03T00:00:00.000Z',
        cwd: '/tmp/sidebar-project',
        id: PROJECT_ID,
        ownerPrincipalId: 'prn_mock00000000',
        state: 'ready',
        title: 'Sidebar Project',
        updatedAt: '2026-07-03T00:00:00.000Z'
      },
      {
        archived: false,
        createdAt: '2026-07-03T00:00:00.000Z',
        cwd: '/tmp/sidebar-second-project',
        id: SECOND_PROJECT_ID,
        ownerPrincipalId: 'prn_mock00000000',
        state: 'ready',
        title: 'Second Project',
        updatedAt: '2026-07-02T00:00:00.000Z'
      }
    ],
    sessions: [
      makeSession(CHAT_SESSION_ID, 'Chat Session 1', 1, null),
      makeSession('ses_chat000000002', 'Chat Session 2', 2, null),
      makeSession('ses_chat000000003', 'Chat Session 3', 3, null),
      makeSession('ses_chat000000004', 'Chat Session 4', 4, null),
      makeSession('ses_chat000000005', 'Chat Session 5', 5, null),
      makeSession('ses_chat000000006', 'Chat Session 6', 6, null),
      makeSession('ses_project0000001', 'Project Session 1', 1),
      makeSession('ses_project0000002', 'Project Session 2', 2),
      makeSession('ses_project0000003', 'Project Session 3', 3),
      makeSession('ses_project0000004', 'Project Session 4', 4),
      makeSession('ses_project0000005', 'Project Session 5', 5),
      makeSession('ses_project0000006', 'Project Session 6', 6),
      makeSession('ses_project0000007', 'Project Session 7', 7),
      makeSession('ses_second0000001', 'Second Project Session', 1, SECOND_PROJECT_ID)
    ],
    sendMessageRequests: [],
    updateProjectRequests: [],
    updateSessionRequests: []
  };
}

async function installSidebarMock(page: Page, state = createSidebarState(), options: SidebarMockOptions = {}) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    window.localStorage.clear();
    const style = document.createElement('style');
    style.textContent =
      '[aria-label="Open TanStack Router Devtools"], .tsqd-parent-container { display: none !important; pointer-events: none !important; }';
    document.documentElement.appendChild(style);
  });
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === 'http://localhost:8402' && url.pathname === '/live.js') return route.abort();
    if (!(url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/') || url.pathname === '/health')) {
      return route.continue();
    }
    const path = url.pathname.replace('/api/v1', '/v1').replace('/api/health', '/health');
    const method = request.method();

    if (method === 'GET' && path === '/health') {
      return route.fulfill(json({ status: 'ok', version: '0.1.1', latestVersion: '0.1.1' }));
    }
    if (method === 'GET' && path === '/v1/init/status') return route.fulfill(json({ initialized: true }));
    if (method === 'GET' && path === '/v1/settings/locale') return route.fulfill(json({ locale: 'en' }));
    if (method === 'GET' && path === '/v1/settings/locales') {
      return route.fulfill(json({ locales: [{ label: 'English', locale: 'en', source: 'built-in' }] }));
    }
    if (method === 'GET' && path === '/v1/i18n/catalog') return route.fulfill(json({ locale: 'en', messages: {} }));
    if (method === 'GET' && path === '/v1/commands') return route.fulfill(json({ commands: [] }));
    if (method === 'GET' && path === '/v1/agents') return route.fulfill(json({ agents: [] }));
    if (method === 'GET' && path === '/v1/settings/model/providers') return route.fulfill(json({ providers: [] }));
    if (method === 'GET' && path === '/v1/settings/model/roles') return route.fulfill(json({ roles: {} }));
    if (method === 'GET' && path === '/v1/settings/model/profiles') {
      return route.fulfill(json({ defaultAlias: 'default', profiles: [] }));
    }
    if (method === 'GET' && path === '/v1/settings/network') {
      return route.fulfill(
        json({
          host: '127.0.0.1',
          https: { enabled: false },
          localHttpFallback: { enabled: true },
          port: 52522,
          remoteAccess: { enabled: false, token: null, tokenRevision: 0 },
          transport: 'uds'
        })
      );
    }
    if (method === 'GET' && path === '/v1/settings/external-agents') return route.fulfill(json({ agents: [] }));
    if (method === 'GET' && path === '/v1/settings/external-agents/presets') {
      return route.fulfill(json({ presets: [] }));
    }
    if (method === 'GET' && path === '/v1/sessions') {
      return route.fulfill(
        json({
          hasMore: false,
          limit: 50,
          offset: 0,
          sessions: state.sessions,
          total: state.sessions.length
        })
      );
    }
    const sessionMessagesMatch = path.match(/^\/v1\/sessions\/([^/]+)\/messages$/);
    if (sessionMessagesMatch && method === 'POST') {
      const sessionId = sessionMessagesMatch[1] ?? '';
      const body = request.postDataJSON() as { text?: string };
      if (!state.sessions.some((session) => session.id === sessionId)) {
        state.invalidSessionRequests.push({ method, path, sessionId });
      }
      state.sendMessageRequests.push({ sessionId, text: body.text });
      return route.fulfill(json({ accepted: true }));
    }
    const provenanceMatch = path.match(/^\/v1\/sessions\/([^/]+)\/provenance$/);
    if (provenanceMatch && method === 'GET') {
      const sessionId = provenanceMatch[1] ?? '';
      if (!state.sessions.some((session) => session.id === sessionId)) {
        state.invalidSessionRequests.push({ method, path, sessionId });
      }
      return route.fulfill(json({ ancestors: [], descendants: [] }));
    }
    if (method === 'POST' && path === '/v1/sessions') {
      await options.createChatSessionGate;
      const body = request.postDataJSON() as { title?: string };
      const id = `ses_newchat${String(state.sessions.length + 1).padStart(5, '0')}`;
      state.sessions.unshift(makeSession(id, body.title ?? 'created chat', 1, null));
      return route.fulfill(json({ sessionId: id }, 201));
    }
    const sessionMatch = path.match(/^\/v1\/sessions\/([^/]+)$/);
    if (sessionMatch && method === 'PATCH') {
      const id = sessionMatch[1] ?? '';
      const body = request.postDataJSON() as { title?: string };
      state.updateSessionRequests.push({ id, title: body.title });
      const session = state.sessions.find((item) => item.id === id);
      if (session && body.title) session.title = body.title;
      return route.fulfill(json({ session }));
    }
    if (sessionMatch && method === 'DELETE') {
      const id = sessionMatch[1] ?? '';
      state.deleteSessionRequests.push(id);
      state.sessions = state.sessions.filter((item) => item.id !== id);
      return route.fulfill(json({ deleted: true }));
    }
    const undoDeleteMatch = path.match(/^\/v1\/sessions\/([^/]+)\/undo-delete$/);
    if (undoDeleteMatch && method === 'POST') return route.fulfill(json({ undone: true }));
    if (method === 'GET' && path === '/v1/workplace/projects') {
      return route.fulfill(json({ hasMore: false, projects: state.projects, total: state.projects.length }));
    }
    if (method === 'POST' && path === '/v1/workplace/projects') {
      const body = request.postDataJSON() as { cwd?: string; title: string };
      state.createProjectRequests.push(body);
      const id = `prj_created_${state.projects.length + 1}`;
      state.projects.push({
        archived: false,
        createdAt: '2026-07-04T00:00:00.000Z',
        cwd: body.cwd,
        id,
        ownerPrincipalId: 'prn_mock00000000',
        state: 'ready',
        title: body.title,
        updatedAt: '2026-07-04T00:00:00.000Z'
      });
      return route.fulfill(json({ projectId: id }, 201));
    }
    const projectMatch = path.match(/^\/v1\/workplace\/projects\/([^/]+)$/);
    if (projectMatch && method === 'PATCH') {
      const id = projectMatch[1] ?? '';
      const body = request.postDataJSON() as { title?: string };
      state.updateProjectRequests.push({ id, title: body.title });
      const project = state.projects.find((item) => item.id === id);
      if (project && body.title) project.title = body.title;
      return route.fulfill(json({ project }));
    }
    if (projectMatch && method === 'DELETE') {
      const id = projectMatch[1] ?? '';
      state.projects = state.projects.filter((item) => item.id !== id);
      return route.fulfill(json({ deleted: true }));
    }
    const projectSessionsMatch = path.match(/^\/v1\/projects\/([^/]+)\/sessions$/);
    if (projectSessionsMatch && method === 'GET') {
      const projectId = projectSessionsMatch[1] ?? '';
      const sessions = state.sessions.filter((session) => session.projectId === projectId);
      return route.fulfill(json({ hasMore: false, limit: 50, offset: 0, sessions, total: sessions.length }));
    }
    if (projectSessionsMatch && method === 'POST') {
      const projectId = projectSessionsMatch[1] ?? '';
      const body = request.postDataJSON() as { title?: string };
      state.createProjectSessionRequests.push({ projectId, title: body.title });
      const id = `ses_newproj${String(state.sessions.length + 1).padStart(5, '0')}`;
      state.sessions.unshift(makeSession(id, body.title ?? 'created project session', 1, projectId));
      return route.fulfill(json({ sessionId: id }, 201));
    }
    if (method === 'GET' && /^\/v1\/projects\/[^/]+\/external-agent-sessions$/.test(path)) {
      return route.fulfill(json({ sessions: [] }));
    }
    if (method === 'GET' && /^\/v1\/sessions\/[^/]+\/external-agent-sessions$/.test(path)) {
      return route.fulfill(json({ sessions: [] }));
    }
    const sessionUiStreamMatch = path.match(/^\/v1\/sessions\/([^/]+)\/ui-stream$/);
    if (sessionUiStreamMatch && method === 'GET') {
      const sessionId = sessionUiStreamMatch[1] ?? '';
      const items =
        sessionId === CHAT_SESSION_ID
          ? [
              {
                id: 'msg_oldchat000001',
                kind: 'message',
                parts: [{ text: 'Old chat transcript should not flash', type: 'text' }],
                role: 'assistant',
                seq: '0001',
                status: 'done'
              },
              {
                id: 'tool_oldchat000001',
                input: { query: 'Old inspector content should not flash' },
                kind: 'tool',
                seq: '0002',
                status: 'ok',
                tool: 'old_inspector_tool'
              }
            ]
          : [];
      return route.fulfill({
        body: `data: ${JSON.stringify({ hasMore: false, items, kind: 'snapshot' })}\n\n`,
        contentType: 'text/event-stream',
        status: 200
      });
    }
    if (method === 'GET' && /^\/v1\/projects\/[^/]+\/ui-stream$/.test(path)) {
      return route.fulfill({
        body: 'data: {"kind":"snapshot","items":[],"hasMore":false}\n\n',
        contentType: 'text/event-stream',
        status: 200
      });
    }
    return route.fulfill(json({}));
  });
  return state;
}

function projectRow(page: Page, name = 'Sidebar Project') {
  return page
    .locator('[data-sidebar-tree-item="true"]')
    .filter({ has: page.getByRole('link', { name }) })
    .first();
}

async function openItemMenu(page: Page, itemName: string) {
  await page.getByRole('link', { name: itemName }).click({ button: 'right' });
}

async function expandAllProjects(page: Page) {
  const expandAll = page.getByRole('button', { name: 'Expand all projects' });
  if (await expandAll.isVisible()) await expandAll.click();
}

test.describe('workspace sidebar interactions', () => {
  test('opens projects without selecting a session, then opens an explicit project session', async ({ page }) => {
    await installSidebarMock(page);
    await page.goto('/');
    await expect(page.getByTestId('daemon-menu-trigger')).toBeVisible();

    await page.getByRole('link', { name: 'Sidebar Project' }).click();
    await expect(page).toHaveURL(new RegExp(`/workspace/${PROJECT_ID}$`));
    await expect(page).not.toHaveURL(/ses_project/);
    await expandAllProjects(page);
    await expect(page.getByRole('link', { name: 'Project Session 1' })).toBeVisible();

    await page.getByRole('link', { name: 'Project Session 1' }).click();
    await expect(page).toHaveURL(new RegExp(`/workspace/${PROJECT_ID}/ses_project0000001$`));
  });

  test('supports project/session pagination, section collapse, and expand-all controls', async ({ page }) => {
    await installSidebarMock(page);
    await page.goto(`/workspace/${PROJECT_ID}`);
    await expandAllProjects(page);
    await expect(page.getByRole('link', { name: 'Project Session 1' })).toBeVisible();

    const sidebarProjectTree = page.getByRole('tree', { name: 'Sidebar Project' });
    await expect(sidebarProjectTree.getByRole('link', { name: 'Project Session 5' })).toBeVisible();
    await expect(sidebarProjectTree.getByRole('link', { name: 'Project Session 6' })).toBeHidden();

    await sidebarProjectTree.getByRole('button', { name: 'More' }).click();
    await expect(sidebarProjectTree.getByRole('link', { name: 'Project Session 6' })).toBeVisible();
    await expect(sidebarProjectTree.getByRole('button', { name: 'Less' })).toBeVisible();

    await sidebarProjectTree.getByRole('button', { name: 'Less' }).click();
    await expect(sidebarProjectTree.getByRole('link', { name: 'Project Session 6' })).toBeHidden();

    await page.getByRole('button', { exact: true, name: 'Projects' }).click();
    await expect(sidebarProjectTree).toBeHidden();

    await page.getByRole('button', { exact: true, name: 'Projects' }).click();
    await expect(sidebarProjectTree).toBeVisible();

    await page.getByRole('button', { name: 'Collapse all projects' }).click();
    await expect(sidebarProjectTree).toBeHidden();
    await page.getByRole('button', { name: 'Expand all projects' }).click();
    await expect(sidebarProjectTree).toBeVisible();

    await page.getByRole('button', { exact: true, name: 'Chats' }).click();
    await expect(page.getByRole('link', { name: 'Chat Session 1' })).toBeHidden();
    await page.getByRole('button', { exact: true, name: 'Chats' }).click();
    await expect(page.getByRole('link', { name: 'Chat Session 1' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Chat Session 6' })).toBeHidden();
    await page.getByRole('button', { name: 'More' }).last().click();
    await expect(page.getByRole('link', { name: 'Chat Session 6' })).toBeVisible();
  });

  test('routes create-session entry points through the New Chat home prefill', async ({ page }) => {
    await installSidebarMock(page);
    await page.goto(`/workspace/${PROJECT_ID}`);
    await expandAllProjects(page);
    await expect(page.getByRole('link', { name: 'Project Session 1' })).toBeVisible();

    await projectRow(page).getByRole('button', { name: 'New project session' }).click({ force: true });
    await expect(page).toHaveURL(/\/$/);
    const home = page.getByRole('main');
    await expect(home.locator('[data-target-mode="project"]')).toBeVisible();
    await expect(home.getByRole('button', { exact: true, name: 'Sidebar Project' })).toBeVisible();

    await page.goto(`/workspace/${PROJECT_ID}`);
    await page.getByRole('button', { name: 'New chat session' }).click({ force: true });
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('main').locator('[data-target-mode="agent"]')).toBeVisible();

    await page.goto(`/workspace/${PROJECT_ID}`);
    await page.getByRole('link', { name: 'New Chat' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('main').locator('[data-target-mode="agent"]')).toBeVisible();
  });

  test('home composer creates a chat session and sends the first user message', async ({ page }) => {
    const createChatSession = deferred();
    const state = await installSidebarMock(page, createSidebarState(), {
      createChatSessionGate: createChatSession.promise
    });
    await page.goto(`/sessions/${CHAT_SESSION_ID}`);
    await expect(page.getByTestId('daemon-menu-trigger')).toBeVisible();
    await expect(page.getByText('Old chat transcript should not flash')).toBeVisible();
    await page.getByRole('button', { exact: true, name: 'Inspector' }).click();
    const rightPanel = page.getByTestId('right-panel');
    await expect(rightPanel.getByText('Old inspector content should not flash').first()).toBeVisible();
    await page.evaluate(
      ({ marker, oldPath }) => {
        type OwnerLeak = { activeOwner: string | null; contentOwner: string | null; path: string };
        const testWindow = window as Window & { __rightPanelOwnerLeaks?: OwnerLeak[] };
        const leaks: OwnerLeak[] = [];
        testWindow.__rightPanelOwnerLeaks = leaks;
        const recordLeak = () => {
          const panel = document.querySelector<HTMLElement>('[data-testid="right-panel"]');
          const visible =
            panel?.getAttribute('aria-hidden') !== 'true' &&
            Boolean(panel?.getBoundingClientRect().width) &&
            (panel ? getComputedStyle(panel).visibility !== 'hidden' : false);
          if (location.pathname !== oldPath && visible && panel?.textContent?.includes(marker)) {
            leaks.push({
              activeOwner: panel.getAttribute('data-right-panel-owner'),
              contentOwner:
                panel
                  .querySelector('[data-right-panel-content-owner]')
                  ?.getAttribute('data-right-panel-content-owner') ?? null,
              path: location.pathname
            });
          }
        };
        const pushState = history.pushState.bind(history);
        const replaceState = history.replaceState.bind(history);
        history.pushState = (...args) => {
          pushState(...args);
          requestAnimationFrame(recordLeak);
        };
        history.replaceState = (...args) => {
          replaceState(...args);
          requestAnimationFrame(recordLeak);
        };
      },
      { marker: 'Old inspector content should not flash', oldPath: `/sessions/${CHAT_SESSION_ID}` }
    );

    await page.getByRole('link', { name: 'New Chat' }).click();
    await expect(page).toHaveURL(/\/$/);

    const draft = 'Investigate the workspace launch flow';
    await page.locator('[aria-label="I want to do..."]').fill(draft);
    await page.getByRole('button', { name: 'Send message' }).click();

    await expect(page).toHaveURL(/\/sessions\/ses_/);
    const transcript = page.getByRole('log');
    await expect(transcript.getByText(draft)).toBeVisible();
    await expect(transcript.locator('[data-message-pending="true"]')).toHaveText('Default Agent');
    createChatSession.resolve();
    await expect(transcript.getByText('Old chat transcript should not flash')).toBeHidden();
    await expect(rightPanel.getByText('Old inspector content should not flash')).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          (
            window as Window & {
              __rightPanelOwnerLeaks?: Array<{ activeOwner: string | null; contentOwner: string | null; path: string }>;
            }
          ).__rightPanelOwnerLeaks ?? []
      )
    ).toEqual([]);
    await expect
      .poll(() => Boolean(state.sessions.find((session) => session.title === draft && session.projectId === null)))
      .toBe(true);
    const created = state.sessions.find((session) => session.title === draft && session.projectId === null);
    expect(created).toBeTruthy();
    await expect(page).toHaveURL(new RegExp(`/sessions/${created?.id}$`));
    await expect(page.getByRole('link', { name: created?.title })).toHaveCount(1);
    expect(state.sendMessageRequests).toContainEqual({ sessionId: created?.id, text: draft });
    expect(state.invalidSessionRequests).toEqual([]);
  });

  test('renames projects and sessions through right-click item menus', async ({ page }) => {
    const state = await installSidebarMock(page);
    await page.goto(`/workspace/${PROJECT_ID}`);
    await expandAllProjects(page);
    await expect(page.getByRole('link', { name: 'Project Session 1' })).toBeVisible();

    await openItemMenu(page, 'Sidebar Project');
    await page.getByRole('menuitem', { name: 'Rename project' }).click();
    await page.getByRole('textbox', { name: 'Sidebar Project' }).fill('Renamed Project');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('link', { name: 'Renamed Project' })).toBeVisible();
    expect(state.updateProjectRequests).toContainEqual({ id: PROJECT_ID, title: 'Renamed Project' });

    await openItemMenu(page, 'Project Session 1');
    await page.getByRole('menuitem', { name: 'Rename session' }).click();
    await page.getByRole('textbox', { name: 'Project Session 1' }).fill('Renamed Project Session');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('link', { name: 'Renamed Project Session' })).toBeVisible();
    expect(state.updateSessionRequests).toContainEqual({ id: 'ses_project0000001', title: 'Renamed Project Session' });

    await openItemMenu(page, 'Chat Session 1');
    await page.getByRole('menuitem', { name: 'Rename session' }).click();
    await page.getByRole('textbox', { name: 'Chat Session 1' }).fill('Renamed Chat Session');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('link', { name: 'Renamed Chat Session' })).toBeVisible();
    expect(state.updateSessionRequests).toContainEqual({ id: CHAT_SESSION_ID, title: 'Renamed Chat Session' });
  });

  test('pins, unpins, deletes sessions, and creates projects from sidebar actions', async ({ page }) => {
    const state = await installSidebarMock(page);
    await page.goto(`/workspace/${PROJECT_ID}`);
    await expandAllProjects(page);
    await expect(page.getByRole('link', { name: 'Project Session 1' })).toBeVisible();

    await page.getByRole('button', { name: 'Pin Project Session 2' }).click({ force: true });
    await expect(page.getByRole('button', { name: 'Pinned' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Project Session 2' })).toBeVisible();

    await page.getByRole('button', { name: 'Unpin Project Session 2' }).click({ force: true });
    await expect(page.getByRole('button', { name: 'Pinned' })).toBeHidden();

    await openItemMenu(page, 'Project Session 3');
    await page.getByRole('menuitem', { name: 'Delete session' }).click();
    await expect(page.getByText('Deleted Project Session 3')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Project Session 3' })).toBeHidden();
    expect(state.deleteSessionRequests).toContain('ses_project0000003');

    await page.getByRole('button', { exact: true, name: 'New project' }).click({ force: true });
    await page.getByRole('textbox', { name: 'Project name' }).fill('Created From Sidebar');
    await page.locator('#new-project-cwd').fill('/tmp/created-from-sidebar');
    await page.getByRole('button', { name: 'Create project' }).click();
    const createdProject = state.projects.find((project) => project.title === 'Created From Sidebar');
    expect(createdProject).toBeTruthy();
    await expect(page.locator(`a[href="/workspace/${createdProject?.id}"]`)).toBeVisible();
    expect(state.createProjectRequests).toContainEqual({
      cwd: '/tmp/created-from-sidebar',
      title: 'Created From Sidebar'
    });
  });
});
