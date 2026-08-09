import type { MessageId, Session, SessionMemberBinding, UIItem } from '@monad/protocol';

import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

import sessionTranscript from './fixtures/session-transcript.json' with { type: 'json' };

const projectId = 'prj_ABCDEF123456';
const projectRouteId = projectId;
const alphaSessionId = 'ses_ALPHA1234567';
const alphaSessionRouteId = alphaSessionId;
const betaSessionId = 'ses_BETA12345678';
const betaSessionRouteId = betaSessionId;

type TranscriptFixtureMessage = {
  id: string;
  replyToMessageId?: string;
  role: 'assistant' | 'user';
  text: string;
  type: string;
};

const transcriptMessages = sessionTranscript as TranscriptFixtureMessage[];

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
    this.addEventListener('monad-workplace-experience:update', () => this.render());
  }

  async render() {
    const host = this.monadWorkplaceExperience;
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

// The real Power Pack Kanban module is served through the same pack-relative asset route used after
// installation. chat-room stays a host-component, mirroring production.
const kanbanExperienceModule = readFileSync(
  new URL('../../../../packages/monad-power-pack/src/experiences/kanban.js', import.meta.url),
  'utf8'
);
const kanbanExperience = {
  entry: {
    module: '/v1/atoms/monad-power-pack/assets/experiences/kanban.js',
    tagName: 'monad-kanban',
    type: 'web-component'
  },
  icon: 'git-fork',
  id: 'kanban',
  title: 'Kanban'
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
    resolveUiMessages?: (request: { messageIds: string[] }) => { items: UIItem[] };
    sessions?: Session[];
    sendProjectMessage?: (request: { text?: string; replyToMessageId?: string; attempt: number }) =>
      | {
          status?: number;
          body?: unknown;
        }
      | Promise<{
          status?: number;
          body?: unknown;
        }>;
    uiItemsWindow?: (request: { after?: string; around?: string; before?: string }) => {
      items: UIItem[];
      newerCursor?: string;
      olderCursor?: string;
    };
    uiItems?: UIItem[];
    uiItemsBySession?: Partial<Record<string, UIItem[]>>;
    uiSnapshot?: { hasMore: boolean; items: UIItem[]; oldestCursor?: string };
  } = {}
) {
  let sendProjectMessageAttempts = 0;
  const projectCwd = '/tmp/mock-workplace';
  const sessions = options.sessions ?? [projectSession(alphaSessionId, 'Alpha session', '2026-07-04T00:00:00.000Z')];
  let kanbanTasks: Array<{
    availableActions: { moveNext: boolean; start: boolean };
    displayState: string;
    documents: Record<'product_design' | 'tech_design', { name: string; path: string; updatedAt: string } | null>;
    host: SessionMemberBinding | null;
    id: string;
    projectId: string;
    sessionId: string;
    stage: string;
    title: string;
    version: number;
    members: SessionMemberBinding[];
  }> = [];
  const kanbanMember: SessionMemberBinding = {
    member: {
      id: 'pmem_CODEX123456',
      projectId,
      profileId: 'tmpl_codex',
      type: 'mesh-agent',
      displayName: 'Codex',
      customPrompt: null,
      workingDirectoryOverride: null,
      launchOverrides: {},
      lifecycle: 'enabled',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z'
    },
    binding: {
      sessionId: alphaSessionId,
      projectMemberId: 'pmem_CODEX123456',
      lifecycle: 'active',
      currentNativeRuntimeSessionId: null,
      lastDeliveredSeq: 0,
      lastVisibleSeq: 0,
      lastHealth: null,
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z'
    }
  };

  await page.route('**/v1/atoms/mock-experience/assets/dist/mock-canvas.js', (route) =>
    route.fulfill({
      body: mockExperienceModule,
      contentType: 'text/javascript',
      status: 200
    })
  );
  await page.route('**/v1/atoms/monad-power-pack/assets/experiences/kanban.js', (route) =>
    route.fulfill({ body: kanbanExperienceModule, contentType: 'text/javascript', status: 200 })
  );
  await page.route('**/avatar-cache/**', (route) =>
    route.fulfill({
      body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
      contentType: 'image/svg+xml',
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
      return route.fulfill(json({ sessions, total: sessions.length, limit: 50, offset: 0 }));
    }
    if (method === 'GET' && path === '/v1/sessions/attention') {
      return route.fulfill(json({ summaries: [] }));
    }
    if (method === 'GET' && path === '/v1/workplace/projects') {
      return route.fulfill(
        json({
          projects: [
            {
              archived: false,
              createdAt: '2026-07-03T00:00:00.000Z',
              cwd: projectCwd,
              id: projectId,
              state: 'active',
              title: 'Mock Project',
              updatedAt: '2026-07-03T00:00:00.000Z'
            }
          ],
          limit: 50,
          offset: 0,
          orderRevision: 0,
          total: 1
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
    if (method === 'GET' && path === '/v1/mesh/agents') return route.fulfill(json({ agents: [] }));
    if (method === 'GET' && path === '/v1/mesh/agents/presets') {
      return route.fulfill(json({ presets: [] }));
    }
    if (method === 'GET' && path === '/v1/mesh/sessions') {
      return route.fulfill(json({ sessions: [] }));
    }
    if (method === 'GET' && path === `/v1/projects/${projectId}/sessions`) {
      const projectSessions = sessions.filter((session) => session.projectId === projectId);
      return route.fulfill(json({ sessions: projectSessions, total: projectSessions.length, limit: 50, offset: 0 }));
    }
    if (method === 'POST' && path === `/v1/projects/${projectId}/sessions`) {
      return route.fulfill(json({ sessionId: alphaSessionId }, 201));
    }
    const uiStreamSessionId = path.match(/^\/v1\/sessions\/([^/]+)\/ui-stream$/)?.[1];
    if (method === 'GET' && uiStreamSessionId) {
      const sessionItems = options.uiItemsBySession?.[uiStreamSessionId];
      return route.fulfill(
        sse({
          kind: 'snapshot',
          ...(uiStreamSessionId === alphaSessionId
            ? (options.uiSnapshot ?? { items: sessionItems ?? options.uiItems ?? [], hasMore: false })
            : { items: sessionItems ?? [], hasMore: false })
        })
      );
    }
    if (method === 'POST' && path === `/v1/sessions/${alphaSessionId}/ui-messages/resolve`) {
      const body = request.postDataJSON() as { messageIds: string[] };
      return route.fulfill(json(options.resolveUiMessages?.(body) ?? { items: [] }));
    }
    if (method === 'GET' && path === `/v1/sessions/${alphaSessionId}/ui-items`) {
      const result = options.uiItemsWindow?.({
        after: url.searchParams.get('after') ?? undefined,
        around: url.searchParams.get('around') ?? undefined,
        before: url.searchParams.get('before') ?? undefined
      });
      return route.fulfill(json(result ?? { items: [] }));
    }
    if (method === 'POST' && path === `/v1/channels/${alphaSessionId}/messages`) {
      sendProjectMessageAttempts += 1;
      const body = request.postDataJSON() as { text?: string; replyToMessageId?: string };
      const result =
        (await options.sendProjectMessage?.({
          text: body.text,
          replyToMessageId: body.replyToMessageId,
          attempt: sendProjectMessageAttempts
        })) ?? {};
      return route.fulfill(json(result.body ?? { accepted: true }, result.status ?? 200));
    }
    if (method === 'GET' && path === '/v1/atoms/workplace-experiences') {
      return route.fulfill(json({ experiences }));
    }
    if (method === 'GET' && path === '/v1/atoms/workplace-experiences/kanban/api/tasks') {
      return route.fulfill(json({ tasks: kanbanTasks, nextCursor: null }));
    }
    if (method === 'GET' && path === '/v1/atoms/workplace-experiences/kanban/api/member-templates') {
      return route.fulfill(
        json({
          templates: [
            {
              id: 'tmpl_codex',
              type: 'mesh-agent',
              name: 'codex',
              displayName: 'GPT 5.6 Sol',
              presentation: {
                avatarUrl: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E',
                icon: 'codex',
                provider: 'codex'
              }
            }
          ]
        })
      );
    }
    if (method === 'POST' && path === '/v1/atoms/workplace-experiences/kanban/api/tasks/create') {
      const body = request.postDataJSON() as { title: string };
      kanbanTasks = [
        {
          availableActions: { moveNext: false, start: false },
          displayState: 'waiting',
          documents: { product_design: null, tech_design: null },
          host: null,
          id: 'task_e2e',
          projectId,
          sessionId: alphaSessionId,
          stage: 'product_design',
          title: body.title,
          version: 0,
          members: []
        }
      ];
      return route.fulfill(json({ task: kanbanTasks[0] }, 201));
    }
    if (method === 'POST' && path === '/v1/atoms/workplace-experiences/kanban/api/tasks/members') {
      const current = kanbanTasks[0];
      if (!current) return route.fulfill(json({ error: 'task missing' }, 404));
      kanbanTasks = [
        {
          ...current,
          availableActions: { moveNext: false, start: true },
          host: kanbanMember
        }
      ];
      return route.fulfill(json({ task: kanbanTasks[0] }));
    }
    if (method === 'POST' && path === '/v1/atoms/workplace-experiences/kanban/api/tasks/members/remove') {
      const current = kanbanTasks[0];
      if (!current) return route.fulfill(json({ error: 'task missing' }, 404));
      kanbanTasks = [
        {
          ...current,
          availableActions: { moveNext: false, start: false },
          host: null,
          members: []
        }
      ];
      return route.fulfill(json({ deleted: true, task: kanbanTasks[0] }));
    }
    if (method === 'POST' && path === '/v1/atoms/workplace-experiences/kanban/api/tasks/start') {
      const current = kanbanTasks[0];
      if (!current) return route.fulfill(json({ error: 'task missing' }, 404));
      kanbanTasks = [
        {
          ...current,
          availableActions: { moveNext: true, start: false },
          displayState: 'ready',
          documents:
            current.stage === 'product_design' || current.stage === 'tech_design'
              ? {
                  ...current.documents,
                  [current.stage]: {
                    name: current.stage === 'product_design' ? 'product-design.md' : 'tech-design.md',
                    path: `/workspace/${current.stage}.md`,
                    updatedAt: '2026-07-22T00:00:00.000Z'
                  }
                }
              : current.documents,
          version: current.version + 1
        }
      ];
      return route.fulfill(json({ task: kanbanTasks[0] }));
    }
    if (method === 'POST' && path === '/v1/atoms/workplace-experiences/kanban/api/tasks/move') {
      const current = kanbanTasks[0];
      const body = request.postDataJSON() as { destination: string };
      if (!current) return route.fulfill(json({ error: 'task missing' }, 404));
      const completed = body.destination === 'completed';
      kanbanTasks = [
        {
          ...current,
          availableActions: { moveNext: false, start: !completed },
          displayState: completed ? 'completed' : 'waiting',
          stage: body.destination,
          version: current.version + 1
        }
      ];
      return route.fulfill(json({ task: kanbanTasks[0] }));
    }
    if (method === 'POST' && path === '/v1/atoms/workplace-experiences/mock-canvas/api/search') {
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
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    createdAt: updatedAt,
    updatedAt
  };
}

async function switchProjectExperience(page: Page, projectTitle: string, experience: string): Promise<void> {
  await page.getByRole('button', { name: projectTitle, exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Experience', exact: true }).hover();
  await page.getByRole('menuitemcheckbox', { name: experience, exact: true }).click();
}

test.describe('workplace experience atoms', () => {
  test('switches the selected project experience from the project entry point', async ({ page }) => {
    await mockWorkplaceApi(page, [kanbanExperience, chatRoomExperience]);

    await page.goto(`/workspace/${projectRouteId}/${alphaSessionRouteId}`);

    await expect(page.locator('monad-kanban')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Mock Project', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Experience', exact: true }).hover();
    await page.keyboard.press('Escape');

    await switchProjectExperience(page, 'Mock Project', 'Chat');
    await expect(page.locator('[contenteditable][aria-label="Message agents"]')).toBeVisible();

    await switchProjectExperience(page, 'Mock Project', 'Kanban');
    await expect(page.locator('monad-kanban')).toBeVisible();
  });

  test('mounts a mock experience as a whole workplace region and lets it call its API', async ({ page }) => {
    await mockWorkplaceApi(page);

    await page.goto(`/workspace/${projectRouteId}/${alphaSessionRouteId}`);
    const canvas = page.locator('mock-canvas');
    await expect(canvas).toBeVisible();
    await expect(page.locator('.workplace-experience-host > style')).toBeHidden();
    await expect(canvas).toHaveAttribute('data-experience-id', 'mock-canvas');
    await expect(canvas).toHaveAttribute('data-host-project-id', projectId);
    await expect(canvas).toHaveAttribute('data-embedded', 'true');
    await expect(canvas).toHaveAttribute(
      'data-api-base-url',
      /\/api\/v1\/atoms\/workplace-experiences\/mock-canvas\/api$/
    );
    await expect(canvas).toHaveAttribute('data-api-result', `api:${projectId}`);
    await expect(canvas).toContainText(`mock canvas mounted for ${projectId} via api:${projectId}`);
  });

  test('ships Power Pack Kanban over the web-component path and dogfoods its host actions', async ({ page }) => {
    await mockWorkplaceApi(page, [kanbanExperience, chatRoomExperience]);

    await page.goto(`/workspace/${projectRouteId}/${alphaSessionRouteId}`);
    const kanban = page.locator('monad-kanban');
    await expect(kanban).toBeVisible({ timeout: 20_000 });
    await expect(kanban).toHaveAttribute('data-experience-id', 'kanban');
    await expect(kanban).toHaveAttribute('data-ready', 'true');
    await expect(kanban).toHaveAttribute('data-project-id', projectId);
    await expect(page.locator('.workplace-experience-host > style')).toBeHidden();
    const stageTitles = kanban.locator('.stage-title');
    await expect(stageTitles).toHaveCount(5);
    const productDesign = kanban.locator('[data-stage="product_design"]');
    await expect(productDesign).toBeVisible({ timeout: 15_000 });
    await expect(kanban.getByRole('button', { name: 'New' })).toHaveCount(1);
    const codexTemplate = kanban.locator('[data-template-id="tmpl_codex"]');
    await expect(codexTemplate.locator('img')).toHaveAttribute('src', /^data:image\/svg\+xml/);
    await productDesign.getByRole('button', { name: 'New' }).click();
    await expect(kanban.getByRole('textbox', { name: 'Session title' })).toBeVisible();
    await kanban.getByRole('textbox', { name: 'Session title' }).fill('Ship five-stage Kanban');
    await kanban.getByRole('button', { name: 'Create' }).click();

    const card = kanban.locator('[data-task-id="task_e2e"]');
    const hostSlot = card.getByRole('group', { name: 'Host' });
    await expect(card.getByRole('button', { name: 'Start' })).toBeDisabled();
    await kanban.locator('[data-template-id="tmpl_codex"]').dragTo(hostSlot);
    await expect(card).toContainText('Codex');
    await expect(card).toContainText('waiting');
    await expect(card.getByRole('button', { name: 'Start' })).toBeEnabled();
    await card.getByRole('button', { name: 'Remove Codex' }).click();
    await expect(card).toContainText('Drop one host');
    await expect(card.getByRole('button', { name: 'Start' })).toBeDisabled();
    await kanban.locator('[data-template-id="tmpl_codex"]').dragTo(hostSlot);
    await expect(card.getByRole('button', { name: 'Start' })).toBeEnabled();
    await card.getByRole('button', { name: 'Start' }).click();
    await expect(card).toHaveAttribute('draggable', 'true');
    await card.dragTo(kanban.locator('[data-stage="tech_design"]'));
    await expect(kanban.locator('[data-stage="tech_design"] [data-task-id="task_e2e"]')).toContainText(
      'Ship five-stage Kanban'
    );
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByRole('button', { name: 'Start' })).toBeEnabled();

    await card.getByRole('button', { name: 'Start' }).click();
    await card.getByRole('button', { name: 'Move to Implementation' }).click();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByRole('button', { name: 'Start' })).toBeEnabled();
    await card.getByRole('button', { name: 'Start' }).click();
    await card.getByRole('button', { name: 'Move to Verify' }).click();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.getByRole('button', { name: 'Start' }).click();
    await card.getByRole('button', { name: 'Move to Completed' }).click();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText('completed');
    await expect(card.getByRole('button', { name: 'Start' })).toBeDisabled();
    await expect(card.getByRole('button', { name: /Move to/ })).toHaveCount(0);

    await switchProjectExperience(page, 'Mock Project', 'Chat');
    await expect(kanban).toBeHidden();
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

    await switchProjectExperience(page, 'Mock Project', 'Kanban');
    await expect(page.locator('monad-kanban')).toBeVisible();
  });

  test('keeps the project experience while switching project sessions', async ({ page }) => {
    await mockWorkplaceApi(page, [kanbanExperience, mockCanvasExperience], {
      sessions: [
        projectSession(alphaSessionId, 'Alpha session', '2026-07-04T00:00:00.000Z'),
        projectSession(betaSessionId, 'Beta session', '2026-07-03T00:00:00.000Z')
      ]
    });

    await page.goto(`/workspace/${projectRouteId}/${alphaSessionRouteId}`);
    await expect(page).toHaveURL(new RegExp(`/workspace/${projectRouteId}/${alphaSessionRouteId}$`));
    await expect(page.getByRole('link', { name: 'Alpha session' })).toBeVisible();
    await expect(page.locator('monad-kanban')).toBeVisible();

    await switchProjectExperience(page, 'Mock Project', 'Mock Canvas');
    await expect(page.locator('mock-canvas:visible')).toHaveCount(1);

    await page.getByRole('link', { name: 'Beta session' }).click();

    await expect(page).toHaveURL(new RegExp(`/workspace/${projectRouteId}/${betaSessionRouteId}$`));
    await expect(page.locator('mock-canvas:visible')).toHaveCount(1);
    await expect(page.locator('monad-kanban:visible')).toHaveCount(0);

    await page.getByRole('link', { name: 'Alpha session' }).click();

    await expect(page).toHaveURL(new RegExp(`/workspace/${projectRouteId}/${alphaSessionRouteId}$`));
    await expect(page.locator('mock-canvas:visible')).toHaveCount(1);
    await expect(page.locator('monad-kanban:visible')).toHaveCount(0);
  });

  test('preserves a cached user message DOM node after switching sessions', async ({ page }) => {
    const alphaItems: UIItem[] = Array.from({ length: 14 }, (_, index) => ({
      id: `msg_${String(index).padStart(12, '0')}` as MessageId,
      kind: 'message',
      parts: [
        {
          text:
            index === 0
              ? 'Alpha first message'
              : `Alpha response ${index} ${'long enough to keep the transcript scrollable '.repeat(5)}`,
          type: 'text'
        }
      ],
      replyable: true,
      role: index === 0 ? 'user' : 'assistant',
      seq: `2026-07-04T00:00:${String(index).padStart(2, '0')}.000Z`,
      status: 'done'
    }));
    const betaItems: UIItem[] = [
      {
        id: 'msg_BETA00000000' as MessageId,
        kind: 'message',
        parts: [{ text: 'Beta message', type: 'text' }],
        replyable: true,
        role: 'user',
        seq: '2026-07-03T00:00:00.000Z',
        status: 'done'
      }
    ];
    await mockWorkplaceApi(page, [chatRoomExperience], {
      sessions: [
        projectSession(alphaSessionId, 'Alpha session', '2026-07-04T00:00:00.000Z'),
        projectSession(betaSessionId, 'Beta session', '2026-07-03T00:00:00.000Z')
      ],
      uiItemsBySession: { [alphaSessionId]: alphaItems, [betaSessionId]: betaItems }
    });

    await page.goto(`/workspace/${projectRouteId}/${alphaSessionRouteId}`);
    const alphaSurface = page.locator(
      `[data-session-ui-instance="project:${projectRouteId}:session:${alphaSessionId}"]`
    );
    const firstMessage = alphaSurface.getByText('Alpha first message', { exact: true });
    const firstRow = alphaSurface.locator('[data-vl-key="msg_000000000000"]');
    const transcript = alphaSurface.locator('.scwf-scroll[role="log"]');
    const messageListShell = alphaSurface.locator('.chat-message-list-shell');
    const appShell = page.locator('.app-shell');
    await expect(page.getByText('Alpha response 13', { exact: false })).toBeVisible();
    await transcript.evaluate((node) => {
      node.scrollTop = 0;
    });
    await expect(firstMessage).toBeVisible();
    await firstRow.evaluate((node) => {
      (node as HTMLElement & { sessionCacheProbe?: string }).sessionCacheProbe = 'retained';
    });
    await messageListShell.evaluate((node) => {
      (node as HTMLElement & { sessionCacheProbe?: string }).sessionCacheProbe = 'retained';
    });
    await appShell.evaluate((node) => {
      (node as HTMLElement & { sessionCacheProbe?: string }).sessionCacheProbe = 'retained';
    });

    for (let index = 0; index < 3; index += 1) {
      await page.getByRole('link', { name: 'Beta session' }).click();
      await expect(page.getByText('Beta message')).toBeVisible();
      await page.getByRole('link', { name: 'Alpha session' }).click();
      await transcript.evaluate((node) => {
        node.scrollTop = 0;
      });
      await expect(firstMessage).toBeVisible();
      await expect
        .poll(() =>
          Promise.all([
            appShell.evaluate(
              (node) => (node as HTMLElement & { sessionCacheProbe?: string }).sessionCacheProbe ?? null
            ),
            messageListShell.evaluate(
              (node) => (node as HTMLElement & { sessionCacheProbe?: string }).sessionCacheProbe ?? null
            ),
            firstRow.evaluate(
              (node) => (node as HTMLElement & { sessionCacheProbe?: string }).sessionCacheProbe ?? null
            )
          ])
        )
        .toEqual(['retained', 'retained', 'retained']);
    }
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
    const editor = page.locator('[contenteditable][aria-label="Message agents"]');
    await editor.fill('hello from optimistic');
    await editor.press('Enter');

    await expect(page.getByText('hello from optimistic')).toBeVisible();
    const outline = page.getByRole('navigation', { name: 'User message outline' });
    await expect(outline).toBeHidden();
    await expect(page.getByRole('button', { name: 'Retry message' })).toBeVisible();
    await expect(editor).toHaveText('');

    await page.getByRole('button', { name: 'Retry message' }).click();

    await expect(page.getByText('hello from optimistic')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry message' })).toBeHidden();
    expect(attempts).toEqual([
      { text: 'hello from optimistic', replyToMessageId: undefined, attempt: 1 },
      { text: 'hello from optimistic', replyToMessageId: undefined, attempt: 2 }
    ]);
  });

  test('keeps the composer editable while a project message request is pending', async ({ page }) => {
    let releaseFirstRequest = (): void => {};
    const firstRequestPending = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    const attempts: string[] = [];
    await mockWorkplaceApi(page, [chatRoomExperience], {
      sendProjectMessage: async ({ attempt, text }) => {
        attempts.push(text ?? '');
        if (attempt === 1) await firstRequestPending;
        return { body: { accepted: true } };
      }
    });

    await page.goto(`/workspace/${projectRouteId}/${alphaSessionRouteId}`);
    const editor = page.locator('[contenteditable][aria-label="Message agents"]');
    await editor.fill('first request');
    await editor.press('Enter');

    await expect(page.getByText('first request')).toBeVisible();
    await expect(editor).toBeEditable();
    await editor.fill('second request');
    await editor.press('Enter');
    await expect.poll(() => attempts).toEqual(['first request', 'second request']);

    releaseFirstRequest();
  });

  test('resolves old reply targets in one batch and jumps to the selected around window', async ({ page }) => {
    const targetFixture = transcriptMessages[0];
    const secondTargetFixture = transcriptMessages[1];
    const replyFixture = transcriptMessages.find(
      (message) => message.replyToMessageId === targetFixture?.id && message.text.trim().length > 0
    );
    if (!targetFixture || !secondTargetFixture || !replyFixture) throw new Error('reply fixtures missing');
    const target = {
      id: targetFixture.id as MessageId,
      kind: 'message' as const,
      parts: [{ text: targetFixture.text, type: 'text' as const }],
      replyable: true,
      role: targetFixture.role,
      seq: targetFixture.id,
      status: 'done' as const
    };
    const secondTarget = {
      id: secondTargetFixture.id as MessageId,
      kind: 'message' as const,
      parts: [{ text: secondTargetFixture.text, type: 'text' as const }],
      replyable: true,
      role: secondTargetFixture.role,
      seq: secondTargetFixture.id,
      status: 'done' as const
    };
    const spacer = {
      id: 'msg_RECENT000000' as UIItem['id'],
      kind: 'message' as const,
      parts: [{ text: 'Recent message between target and reply', type: 'text' as const }],
      replyable: true,
      role: 'user' as const,
      seq: 'msg_RECENT000000',
      status: 'done' as const
    };
    const reply = {
      id: replyFixture.id as UIItem['id'],
      kind: 'message' as const,
      parts: [{ text: replyFixture.text, type: 'text' as const }],
      replyToMessageId: target.id,
      replyable: true,
      role: replyFixture.role,
      seq: replyFixture.id,
      status: 'done' as const
    };
    const secondReply = {
      id: 'msg_SECONDREPLY0' as MessageId,
      kind: 'message' as const,
      parts: [{ text: 'Reply to the second old target', type: 'text' as const }],
      replyToMessageId: secondTarget.id,
      replyable: true,
      role: 'user' as const,
      seq: 'msg_SECONDREPLY0',
      status: 'done' as const
    };
    const duplicateTargetReply = {
      id: 'msg_DUPLICATE000' as MessageId,
      kind: 'message' as const,
      parts: [{ text: 'Another reply to the first old target', type: 'text' as const }],
      replyToMessageId: target.id,
      replyable: true,
      role: 'assistant' as const,
      seq: 'msg_DUPLICATE000',
      status: 'done' as const
    };
    const resolveCalls: string[][] = [];
    const aroundCalls: string[] = [];
    await mockWorkplaceApi(page, [chatRoomExperience], {
      resolveUiMessages: ({ messageIds }) => {
        resolveCalls.push(messageIds);
        const items: UIItem[] = [];
        for (const messageId of messageIds) {
          if (messageId === target.id) items.push(target);
          if (messageId === secondTarget.id) items.push(secondTarget);
        }
        return { items };
      },
      uiItemsWindow: ({ around }) => {
        if (around) aroundCalls.push(around);
        return { items: around === secondTarget.id ? [secondTarget, spacer, secondReply] : [] };
      },
      uiSnapshot: {
        hasMore: true,
        items: [spacer, reply, secondReply, duplicateTargetReply],
        oldestCursor: spacer.id
      }
    });

    await page.goto(`/workspace/${projectRouteId}/${alphaSessionRouteId}`);
    const firstTargetPreviews = page.getByRole('button').filter({ hasText: targetFixture.text });
    const secondTargetPreview = page.getByRole('button').filter({ hasText: secondTargetFixture.text });
    await expect(firstTargetPreviews).toHaveCount(2);
    await expect(firstTargetPreviews.first()).toBeVisible();
    await expect(secondTargetPreview).toBeVisible();
    expect(resolveCalls).toEqual([[target.id, secondTarget.id]]);

    await secondTargetPreview.click();
    await expect(page.locator('.message-deep-link-target')).toContainText(secondTargetFixture.text);
    expect(aroundCalls).toEqual([secondTarget.id]);
  });

  test('pages a contiguous detached Workplace window and returns to the live tail', async ({ page }) => {
    const target: UIItem = {
      id: 'msg_HISTTARGET01' as MessageId,
      kind: 'message',
      parts: [{ text: 'Detached target', type: 'text' }],
      replyable: true,
      role: 'user',
      seq: 'msg_DETACH000020',
      status: 'done'
    };
    const liveReply: UIItem = {
      id: 'msg_LIVEREPLY001' as MessageId,
      kind: 'message',
      parts: [{ text: 'Live reply into older history', type: 'text' }],
      replyToMessageId: target.id as MessageId,
      replyable: true,
      role: 'assistant',
      seq: 'msg_LIVEREPLY001',
      status: 'done'
    };
    const liveTail: UIItem = {
      id: 'msg_LIVETAIL0001' as MessageId,
      kind: 'message',
      parts: [{ text: 'Current live tail only', type: 'text' }],
      replyable: true,
      role: 'user',
      seq: 'msg_LIVETAIL0001',
      status: 'done'
    };
    const detached = Array.from(
      { length: 40 },
      (_, index): UIItem => ({
        id: `msg_DETACH${String(index).padStart(6, '0')}` as MessageId,
        kind: 'message',
        parts: [{ text: index === 21 ? 'Detached context marker' : `Detached message ${index}`, type: 'text' }],
        replyable: true,
        role: index % 2 === 0 ? 'user' : 'assistant',
        seq: `msg_DETACH${String(index).padStart(6, '0')}`,
        status: 'done'
      })
    );
    detached[20] = target;
    const forward = Array.from(
      { length: 30 },
      (_, index): UIItem => ({
        id: `msg_FORWARD${String(index).padStart(5, '0')}` as MessageId,
        kind: 'message',
        parts: [{ text: `Forward page ${index + 1}`, type: 'text' }],
        replyable: true,
        role: index % 2 === 0 ? 'assistant' : 'user',
        seq: `msg_FORWARD${String(index).padStart(5, '0')}`,
        status: 'done'
      })
    );
    const aroundCalls: string[] = [];
    const afterCalls: string[] = [];
    const detachedCursor = detached.at(-1)?.id;
    if (!detachedCursor) throw new Error('detached cursor missing');
    await mockWorkplaceApi(page, [chatRoomExperience], {
      resolveUiMessages: () => ({ items: [target] }),
      uiItemsWindow: ({ after, around }) => {
        if (around) {
          aroundCalls.push(around);
          return { items: detached, newerCursor: detachedCursor };
        }
        if (after) {
          afterCalls.push(after);
          return { items: forward, newerCursor: forward.at(-1)?.id };
        }
        return { items: [] };
      },
      uiSnapshot: { hasMore: false, items: [liveReply, liveTail] }
    });

    await page.goto(`/workspace/${projectRouteId}/${alphaSessionRouteId}`);
    await page.getByRole('button').filter({ hasText: 'Detached target' }).click();
    await expect(page.locator('.message-deep-link-target')).toContainText('Detached target');
    await expect(page.getByText('Current live tail only')).toBeHidden();
    expect(aroundCalls).toEqual([target.id]);

    const jumpLatest = page.getByRole('button', { name: 'Jump to latest messages' });
    await expect(jumpLatest).toBeVisible();
    await page.locator('.scwf-scroll[role="log"]').evaluate((node) => {
      const scroller = node as HTMLElement;
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event('scroll'));
    });
    await expect(page.getByText('Forward page 30')).toBeVisible();
    expect(afterCalls[0]).toBe(detachedCursor);

    await jumpLatest.click();
    await expect(page.getByText('Current live tail only')).toBeVisible();
    await expect(page.getByText('Detached context marker')).toBeHidden();
  });

  test('renders a tombstone when a rewound reply target is no longer resolvable', async ({ page }) => {
    const replyFixture = transcriptMessages.find((message) => message.replyToMessageId === 'msg_DELETED00000');
    if (!replyFixture?.replyToMessageId) throw new Error('deleted-target reply fixture missing');
    const reply = {
      id: replyFixture.id as UIItem['id'],
      kind: 'message' as const,
      parts: [{ text: replyFixture.text, type: 'text' as const }],
      replyToMessageId: replyFixture.replyToMessageId as MessageId,
      replyable: true,
      role: replyFixture.role,
      seq: replyFixture.id,
      status: 'done' as const
    };
    const resolveCalls: string[][] = [];
    await mockWorkplaceApi(page, [chatRoomExperience], {
      resolveUiMessages: ({ messageIds }) => {
        resolveCalls.push(messageIds);
        return { items: [] };
      },
      uiSnapshot: { hasMore: false, items: [reply] }
    });

    await page.goto(`/workspace/${projectRouteId}/${alphaSessionRouteId}`);
    const tombstone = page.getByRole('button', { name: 'Message unavailable' });
    await expect(tombstone).toBeDisabled();
    expect(resolveCalls).toEqual([[reply.replyToMessageId]]);
  });

  test('replaces the chat composer with the approval panel and keeps remembered scopes in its menu', async ({
    page
  }) => {
    await mockWorkplaceApi(page, [chatRoomExperience], {
      uiItems: [
        {
          id: 'approval_REVIEW1234',
          input: { command: 'bun run test' },
          key: 'shell_exec',
          kind: 'approval',
          seq: 'evt_APPROVAL1234',
          tool: 'shell_exec'
        }
      ]
    });

    await page.goto(`/workspace/${projectRouteId}/${alphaSessionRouteId}`);

    const approval = page.getByRole('group', { name: 'Approval' });
    await expect(approval).toBeVisible();
    const composerHost = page.locator('.monad-ui-composer-host');
    await expect(composerHost).toHaveAttribute('aria-hidden', 'true');
    await expect(composerHost).toHaveJSProperty('inert', true);
    await expect(approval.getByRole('button', { name: /Allow once/ })).toBeVisible();

    await approval.getByRole('button', { name: 'More approval options' }).click();
    await expect(page.getByRole('menuitem', { name: 'Allow this session' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Always allow' })).toBeVisible();
  });

  test('shows the user message outline only when there are more than five user messages', async ({ page }) => {
    const uiItems: UIItem[] = Array.from({ length: 5 }, (_, index) => {
      const id = `msg_OUTLINE${String(index + 1).padStart(5, '0')}` as UIItem['id'];
      return {
        id,
        kind: 'message',
        parts: [{ text: `outline message ${index + 1}`, type: 'text' }],
        replyable: true,
        role: 'user',
        seq: id,
        status: 'done'
      };
    });
    await mockWorkplaceApi(page, [chatRoomExperience], { uiItems });
    await page.goto(`/workspace/${projectRouteId}/${alphaSessionRouteId}`);

    const editor = page.locator('[contenteditable][aria-label="Message agents"]');
    const outline = page.getByRole('navigation', { name: 'User message outline' });
    await expect(page.getByText('outline message 5')).toBeVisible();
    await expect(outline).toBeHidden();

    await editor.fill('outline message 6');
    await editor.press('Enter');
    await expect(outline).toBeVisible();
    await expect(outline.getByRole('button', { name: /outline message 6/ })).toBeVisible();
  });

  test('settles chat at the true bottom and keeps downward overscroll stationary', async ({ page }) => {
    await page.setViewportSize({ width: 1_100, height: 1_000 });
    await page.addInitScript(() => {
      Reflect.set(window, '__jumpLatestAppearedDuringInitialLoad', false);
      Reflect.set(window, '__lastMessageMutationCount', 0);
      Reflect.set(window, '__lastMessageMutations', []);
      new MutationObserver((records) => {
        if (document.querySelector('button[aria-label="Jump to latest messages"]')) {
          Reflect.set(window, '__jumpLatestAppearedDuringInitialLoad', true);
        }
        const list = document.querySelector('[data-testid="virtuoso-item-list"]');
        const lastRow = list?.lastElementChild;
        if (lastRow && records.some((record) => lastRow.contains(record.target))) {
          Reflect.set(
            window,
            '__lastMessageMutationCount',
            Number(Reflect.get(window, '__lastMessageMutationCount')) + 1
          );
          Reflect.set(
            window,
            '__lastMessageMutations',
            records
              .filter((record) => lastRow.contains(record.target))
              .map((record) => ({
                added: [...record.addedNodes].map((child) => child.nodeName),
                removed: [...record.removedNodes].map((child) => child.nodeName),
                target: record.target.nodeName,
                type: record.type
              }))
          );
        }
      }).observe(document, { childList: true, subtree: true });
    });
    const uiItems: UIItem[] = Array.from({ length: 60 }, (_, index) => {
      const id = `msg_SCROLL${String(index + 1).padStart(5, '0')}` as UIItem['id'];
      return {
        id,
        kind: 'message',
        parts: [
          {
            text:
              index === 59
                ? 'Message Tasks 2–3 are GREEN.\n\n- store: `apps/monad/src/store/db/message-mutations.ts`\n- ingress: [event bus](https://example.com/event-bus)\n- verify the durable keys and terminal routing contract.'
                : `scroll stability message ${index + 1} ${'with enough content to produce a measured transcript row. '.repeat((index % 3) + 1)}`,
            type: 'text'
          }
        ],
        replyable: true,
        role: index % 2 === 0 ? 'user' : 'assistant',
        seq: id,
        status: 'done'
      };
    });
    const lastMessage = uiItems[59];
    if (lastMessage?.kind !== 'message') throw new Error('expected the last UI item to be a message');
    const lastMessageText = lastMessage.parts.find((part) => part.type === 'text')?.text ?? '';
    const streamingUpdates = Array.from({ length: 18 }, (_, index) => ({
      item: {
        ...lastMessage,
        parts: [
          {
            text: `${lastMessageText}\n\n${'Additional streamed line that increases the measured message height.\n'.repeat(index + 1)}`,
            type: 'text' as const
          }
        ],
        status: 'streaming' as const
      },
      kind: 'upsert' as const
    }));
    await page.addInitScript(
      ({ sessionId, snapshot, updates }) => {
        const nativeFetch = window.fetch.bind(window);
        window.fetch = (async (input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          if (!url.includes(`/v1/sessions/${sessionId}/ui-stream`)) return nativeFetch(input, init);
          const encoder = new TextEncoder();
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`));
                Reflect.set(window, '__startStreamingResizeSequence', () => {
                  let index = 0;
                  const timer = window.setInterval(() => {
                    const update = updates[index];
                    if (!update) {
                      window.clearInterval(timer);
                      Reflect.set(window, '__streamingResizeSequenceComplete', true);
                      return;
                    }
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(update)}\n\n`));
                    index += 1;
                  }, 24);
                });
              }
            }),
            { headers: { 'content-type': 'text/event-stream' }, status: 200 }
          );
        }) as typeof window.fetch;
      },
      {
        sessionId: alphaSessionId,
        snapshot: { kind: 'snapshot' as const, items: uiItems, hasMore: false },
        updates: streamingUpdates
      }
    );
    await mockWorkplaceApi(page, [chatRoomExperience], { uiItems });
    await page.goto(`/workspace/${projectRouteId}/${alphaSessionRouteId}`);
    await expect(page.locator('[contenteditable][aria-label="Message agents"]')).toBeVisible();

    const scroll = page.locator('.scwf-scroll[role="log"]');
    const jumpLatest = page.getByRole('button', { name: 'Jump to latest messages' });
    await expect
      .poll(() =>
        scroll.evaluate((node) => {
          const scroller = node as HTMLElement;
          return Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop);
        })
      )
      .toBeLessThanOrEqual(1);
    // presence-ok: initial bottom settlement must keep the jump-to-latest control hidden.
    await expect(jumpLatest).toBeHidden();
    expect(await page.evaluate(() => Reflect.get(window, '__jumpLatestAppearedDuringInitialLoad'))).toBe(false);
    await page.evaluate(() => {
      Reflect.set(window, '__jumpLatestAppearedDuringInitialLoad', false);
      Reflect.set(window, '__lastMessageMutationCount', 0);
      Reflect.set(window, '__lastMessageMutations', []);
    });
    await expect(page.locator('a[href="https://example.com/event-bus"]')).toBeVisible();
    expect(
      await page.evaluate(() => ({
        jumpAppeared: Reflect.get(window, '__jumpLatestAppearedDuringInitialLoad'),
        lastMessageMutations: Reflect.get(window, '__lastMessageMutationCount'),
        mutations: Reflect.get(window, '__lastMessageMutations')
      }))
    ).toEqual({ jumpAppeared: false, lastMessageMutations: 0, mutations: [] });
    await page.evaluate(() => {
      Reflect.set(window, '__jumpLatestAppearedDuringInitialLoad', false);
      const start = Reflect.get(window, '__startStreamingResizeSequence');
      if (typeof start === 'function') start();
    });
    await expect.poll(() => page.evaluate(() => Reflect.get(window, '__streamingResizeSequenceComplete'))).toBe(true);
    await expect
      .poll(() =>
        scroll.evaluate((node) => {
          const scroller = node as HTMLElement;
          return Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop);
        })
      )
      .toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => Reflect.get(window, '__jumpLatestAppearedDuringInitialLoad'))).toBe(false);
    await expect(jumpLatest).toBeHidden();

    const originalComposerClearance = await scroll.evaluate((node) => {
      const transcript = node.closest<HTMLElement>('[style*="--chat-room-composer-clearance"]');
      const clearance = transcript?.style.getPropertyValue('--chat-room-composer-clearance') ?? '';
      transcript?.style.setProperty('--chat-room-composer-clearance', '260px');
      return clearance;
    });
    await expect
      .poll(() =>
        scroll.evaluate((node) => {
          const scroller = node as HTMLElement;
          return Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop);
        })
      )
      .toBeLessThanOrEqual(1);
    // presence-ok: resizing the composer buffer while pinned must not expose the jump control.
    await expect(jumpLatest).toBeHidden();
    await scroll.evaluate((node, clearance) => {
      node
        .closest<HTMLElement>('[style*="--chat-room-composer-clearance"]')
        ?.style.setProperty('--chat-room-composer-clearance', clearance);
    }, originalComposerClearance);
    await expect
      .poll(() =>
        scroll.evaluate(
          (node) =>
            new Promise<boolean>((resolve) => {
              const scroller = node as HTMLElement;
              const positions: number[] = [];
              const sample = () => {
                positions.push(scroller.scrollTop);
                if (positions.length < 4) {
                  requestAnimationFrame(sample);
                  return;
                }
                resolve(
                  Math.max(...positions) === Math.min(...positions) &&
                    Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) <= 1
                );
              };
              requestAnimationFrame(sample);
            })
        )
      )
      .toBe(true);
    const idleScroll = await scroll.evaluate(
      (node) =>
        new Promise<{ eventCount: number; maxTop: number; minTop: number }>((resolve) => {
          const scroller = node as HTMLElement;
          const positions: number[] = [];
          let eventCount = 0;
          let frameCount = 0;
          const onScroll = () => {
            eventCount += 1;
          };
          const sample = () => {
            positions.push(scroller.scrollTop);
            frameCount += 1;
            if (frameCount < 60) requestAnimationFrame(sample);
            else {
              scroller.removeEventListener('scroll', onScroll);
              resolve({ eventCount, maxTop: Math.max(...positions), minTop: Math.min(...positions) });
            }
          };
          scroller.addEventListener('scroll', onScroll);
          requestAnimationFrame(sample);
        })
    );
    expect({
      movement: idleScroll.maxTop - idleScroll.minTop,
      repeatedScrollEvents: idleScroll.eventCount > 1
    }).toEqual({ movement: 0, repeatedScrollEvents: false });

    await scroll.hover();
    const overscrollTransforms: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      await page.mouse.wheel(0, 600);
      overscrollTransforms.push(await scroll.evaluate((node) => getComputedStyle(node).transform));
    }
    expect(overscrollTransforms).toEqual(['none', 'none', 'none']);
    await expect
      .poll(() =>
        scroll.evaluate((node) => {
          const scroller = node as HTMLElement;
          return {
            atBottom: Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) <= 1,
            transform: getComputedStyle(scroller).transform
          };
        })
      )
      .toEqual({ atBottom: true, transform: 'none' });

    await page.mouse.wheel(0, -600);
    // presence-ok: leaving the bottom must expose the jump-to-latest control.
    await expect(jumpLatest).toBeVisible();
    await jumpLatest.click();
    await expect
      .poll(() =>
        scroll.evaluate((node) => {
          const scroller = node as HTMLElement;
          return Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop);
        })
      )
      .toBeLessThanOrEqual(1);
    // presence-ok: returning to the true bottom must hide the jump-to-latest control.
    await expect(jumpLatest).toBeHidden();

    await page.mouse.wheel(0, -600);
    await expect(jumpLatest).toBeVisible();
    await scroll.evaluate((node) => {
      const scroller = node as HTMLElement;
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
      if (!descriptor?.get || !descriptor.set) throw new Error('scrollTop descriptor unavailable');
      Object.defineProperty(scroller, 'scrollTop', {
        configurable: true,
        get: () => Math.max(0, (descriptor.get?.call(scroller) as number) - 2),
        set: (value: number) => descriptor.set?.call(scroller, value)
      });
    });

    await jumpLatest.click();
    // presence-ok: a sub-threshold browser rounding residual must still complete bottom settlement.
    await expect(jumpLatest).toBeHidden();
    const roundedBottomIdle = await scroll.evaluate(
      (node) =>
        new Promise<{ eventCount: number; gap: number; movement: number }>((resolve) => {
          const scroller = node as HTMLElement;
          const positions: number[] = [];
          let eventCount = 0;
          let frameCount = 0;
          const onScroll = () => {
            eventCount += 1;
          };
          const sample = () => {
            positions.push(scroller.scrollTop);
            frameCount += 1;
            if (frameCount < 60) requestAnimationFrame(sample);
            else {
              scroller.removeEventListener('scroll', onScroll);
              resolve({
                eventCount,
                gap: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
                movement: Math.max(...positions) - Math.min(...positions)
              });
            }
          };
          scroller.addEventListener('scroll', onScroll);
          requestAnimationFrame(sample);
        })
    );
    expect({
      gap: roundedBottomIdle.gap,
      movement: roundedBottomIdle.movement,
      repeatedScrollEvents: roundedBottomIdle.eventCount > 1
    }).toEqual({ gap: 2, movement: 0, repeatedScrollEvents: false });
  });
});
