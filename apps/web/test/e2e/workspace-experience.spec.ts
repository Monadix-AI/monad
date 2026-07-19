import type { Session, UIItem } from '@monad/protocol';

import { readFileSync } from 'node:fs';
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
    sessions?: Session[];
    sendProjectMessage?: (request: { text?: string; attempt: number }) => { status?: number; body?: unknown };
    uiItems?: UIItem[];
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
  await page.route('**/v1/atoms/monad-power-pack/assets/experiences/kanban.js', (route) =>
    route.fulfill({ body: kanbanExperienceModule, contentType: 'text/javascript', status: 200 })
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
    if (method === 'GET' && path === '/v1/mesh/agents') return route.fulfill(json({ agents: [] }));
    if (method === 'GET' && path === '/v1/mesh/agents/presets') {
      return route.fulfill(json({ presets: [] }));
    }
    if (method === 'GET' && path === '/v1/mesh/sessions') {
      return route.fulfill(json({ sessions: [] }));
    }
    if (method === 'GET' && path === `/v1/projects/${projectId}/sessions`) {
      return route.fulfill(json({ sessions: sessions.filter((session) => session.projectId === projectId) }));
    }
    if (method === 'POST' && path === `/v1/projects/${projectId}/sessions`) {
      return route.fulfill(json({ sessionId: alphaSessionId }, 201));
    }
    if (method === 'GET' && path === `/v1/sessions/${alphaSessionId}/ui-stream`) {
      return route.fulfill(sse({ kind: 'snapshot', items: options.uiItems ?? [], hasMore: false }));
    }
    if (method === 'POST' && path === `/v1/channels/${alphaSessionId}/messages`) {
      sendProjectMessageAttempts += 1;
      const body = request.postDataJSON() as { text?: string };
      const result = options.sendProjectMessage?.({ text: body.text, attempt: sendProjectMessageAttempts }) ?? {};
      return route.fulfill(json(result.body ?? { accepted: true }, result.status ?? 200));
    }
    if (method === 'GET' && path === '/v1/atoms/workspace-experiences') {
      return route.fulfill(json({ experiences }));
    }
    if (method === 'GET' && path === '/v1/atoms/workspace-experiences/kanban/api/tasks') {
      return route.fulfill(json({ tasks: [], nextCursor: null }));
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
    state: 'active',
    agentIds: [],
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
    await expect(page.locator('.workspace-experience-host > style')).toBeHidden();
    await expect(canvas).toHaveAttribute('data-experience-id', 'mock-canvas');
    await expect(canvas).toHaveAttribute('data-host-project-id', projectId);
    await expect(canvas).toHaveAttribute('data-embedded', 'true');
    await expect(canvas).toHaveAttribute(
      'data-api-base-url',
      /\/api\/v1\/atoms\/workspace-experiences\/mock-canvas\/api$/
    );
    await expect(canvas).toHaveAttribute('data-api-result', `api:${projectId}`);
    await expect(canvas).toContainText(`mock canvas mounted for ${projectId} via api:${projectId}`);
  });

  test('ships Power Pack Kanban over the web-component path and dogfoods its host actions', async ({ page }) => {
    await mockWorkplaceApi(page, [kanbanExperience, chatRoomExperience]);

    await page.goto(`/workspace/${projectRouteId}/${alphaSessionRouteId}`);
    await expect(page.locator('.project-topbar-name', { hasText: 'Mock Project' })).toBeVisible({ timeout: 20_000 });

    const kanban = page.locator('monad-kanban');
    await expect(kanban).toBeVisible();
    await expect(kanban).toHaveAttribute('data-experience-id', 'kanban');
    // Rendered from the published host snapshot delivered over the event bridge.
    await expect(kanban).toHaveAttribute('data-ready', 'true');
    await expect(kanban).toHaveAttribute('data-project-id', projectId);
    await expect(page.locator('.workspace-experience-host > style')).toBeHidden();
    await expect(kanban).toContainText('PROJECT AUTOPILOT');
    await expect(kanban).toContainText('Requirements');
    await expect(kanban).toContainText('Execution');
    await expect(kanban).toContainText('Acceptance');

    // The host menu switches to chat-room and unmounts the third-party web component.
    await page.getByRole('button', { name: 'Project view mode' }).click();
    await page.getByRole('menuitem', { name: 'Chat' }).click();
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

    // And the host menu can switch back to Kanban, re-mounting the same web-component.
    await page.getByRole('button', { name: 'Project view mode' }).click();
    await page.getByRole('menuitem', { name: 'Kanban' }).click();
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
    await expect(page.locator('.project-topbar-name', { hasText: 'Mock Project' })).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(new RegExp(`/workspace/${projectRouteId}/${alphaSessionRouteId}$`));
    await expect(page.getByRole('link', { name: 'Alpha session' })).toBeVisible();
    await expect(page.locator('monad-kanban')).toBeVisible();

    await page.getByRole('button', { name: 'Project view mode' }).click();
    await page.getByRole('menuitem', { name: 'Mock Canvas' }).click();
    await expect(page.locator('mock-canvas')).toBeVisible();

    await page.getByRole('link', { name: 'Beta session' }).click();

    await expect(page).toHaveURL(new RegExp(`/workspace/${projectRouteId}/${betaSessionRouteId}$`));
    await expect(page.locator('mock-canvas')).toBeVisible();
    await expect(page.locator('monad-kanban')).toBeHidden();

    await page.getByRole('link', { name: 'Alpha session' }).click();

    await expect(page).toHaveURL(new RegExp(`/workspace/${projectRouteId}/${alphaSessionRouteId}$`));
    await expect(page.locator('mock-canvas')).toBeVisible();
    await expect(page.locator('monad-kanban')).toBeHidden();
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
    await expect(outline).toBeHidden();
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

  test('shows the user message outline only when there are more than five user messages', async ({ page }) => {
    const uiItems: UIItem[] = Array.from({ length: 5 }, (_, index) => {
      const id = `msg_OUTLINE${String(index + 1).padStart(5, '0')}` as UIItem['id'];
      return {
        id,
        kind: 'message',
        parts: [{ text: `outline message ${index + 1}`, type: 'text' }],
        role: 'user',
        seq: id,
        status: 'done'
      };
    });
    await mockWorkplaceApi(page, [chatRoomExperience], { uiItems });
    await page.goto(`/workspace/${projectRouteId}/${alphaSessionRouteId}`);
    await expect(page.locator('.project-topbar-name', { hasText: 'Mock Project' })).toBeVisible({ timeout: 20_000 });

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
    await page.route('**/MarkdownRenderer.tsx*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      await route.continue();
    });
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
    await expect(page.locator('.project-topbar-name', { hasText: 'Mock Project' })).toBeVisible({ timeout: 20_000 });
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

    const initialLayout = await scroll.evaluate((node) => {
      const scroller = node as HTMLElement;
      const composer = document.querySelector<HTMLElement>('[aria-label="Message composer"]');
      const style = getComputedStyle(scroller);
      return {
        composerMinHeight: composer ? getComputedStyle(composer).minBlockSize : '',
        overscrollBehaviorY: style.overscrollBehaviorY,
        scrollTop: scroller.scrollTop,
        transform: style.transform
      };
    });
    expect(initialLayout).toEqual({
      composerMinHeight: '104px',
      overscrollBehaviorY: 'none',
      scrollTop: expect.any(Number),
      transform: 'none'
    });

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
    expect(roundedBottomIdle).toEqual({ eventCount: 0, gap: 2, movement: 0 });
  });
});
