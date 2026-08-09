import { expect, type Page, test } from '@playwright/test';

import { API_ROUTE_PATTERN } from './api-route-pattern';

function json(body: unknown, status = 200) {
  return {
    body: JSON.stringify(body),
    contentType: 'application/json',
    status
  };
}

async function installStudioIaApiMock(
  page: Page,
  requests: Array<{ body?: unknown; method: string; path: string }> = []
) {
  let newlySavedPairingId: string | undefined;
  let newlySavedPairingStatusReads = 0;
  await page.route(API_ROUTE_PATTERN, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!(url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/') || url.pathname === '/health')) {
      return route.continue();
    }

    const path = url.pathname.replace('/api/v1', '/v1').replace('/api/health', '/health');
    const method = request.method();

    if (method === 'GET' && path === '/v1/atoms') {
      return route.fulfill(
        json({
          atomPacks: [
            {
              name: 'wa',
              displayName: 'WhatsApp Pack',
              version: '1.0.0',
              atoms: ['channel'],
              enabled: true,
              source: 'local:/tmp/wa-pack',
              sourceKind: 'local',
              revision: 'old-revision',
              canUpdate: true,
              atomDetails: [
                {
                  kind: 'channel',
                  id: 'whatsapp',
                  name: 'WhatsApp',
                  channel: {
                    connectionMode: 'pairing',
                    icon: { title: 'WhatsApp', hex: '25D366', path: 'M0 0h24v24H0z' },
                    setup: {
                      summary: 'Link WhatsApp as a companion device.',
                      steps: ['Save the connection.', 'Open Linked Devices.', 'Scan the QR code.'],
                      docsUrl: 'https://faq.whatsapp.com/1317564962315842'
                    },
                    envVars: []
                  }
                }
              ]
            },
            {
              name: 'manual-pack',
              displayName: 'Manual Pack',
              version: '1.0.0',
              atoms: [],
              enabled: true,
              canUpdate: false,
              atomDetails: []
            }
          ],
          conflicts: []
        })
      );
    }
    if (method === 'GET' && path === '/v1/settings/model/atom-kinds') return route.fulfill(json({ kinds: [] }));
    if (method === 'GET' && path === '/v1/settings/channels') {
      return route.fulfill(
        json({
          channels: [
            {
              id: 'chn_mockwhatsapp',
              type: 'whatsapp',
              label: 'WhatsApp inbox',
              enabled: false,
              mapping: { granularity: 'per-conversation' },
              credentialConfigured: false,
              rateLimitPerMin: 20
            },
            {
              id: 'chn_mockwhatsappalerts',
              type: 'whatsapp',
              label: 'WhatsApp alerts',
              enabled: true,
              mapping: { granularity: 'per-conversation' },
              credentialConfigured: true,
              rateLimitPerMin: 20
            },
            {
              id: 'chn_mocklegacy',
              type: 'legacy-chat',
              label: 'Legacy inbox',
              enabled: false,
              mapping: { granularity: 'per-conversation' },
              credentialConfigured: true,
              rateLimitPerMin: 20
            }
          ]
        })
      );
    }
    if (method === 'GET' && path === '/v1/settings/channels/status') {
      requests.push({ method, path });
      if (newlySavedPairingId) newlySavedPairingStatusReads += 1;
      return route.fulfill(
        json({
          statuses: [
            {
              id: 'chn_mockwhatsapp',
              type: 'whatsapp',
              enabled: false,
              connected: false,
              phase: 'disabled',
              hasToken: false,
              activeConversations: 0
            },
            {
              id: 'chn_mockwhatsappalerts',
              type: 'whatsapp',
              enabled: true,
              connected: true,
              phase: 'connected',
              hasToken: true,
              activeConversations: 2
            },
            ...(newlySavedPairingId
              ? [
                  {
                    id: newlySavedPairingId,
                    type: 'whatsapp',
                    enabled: true,
                    connected: newlySavedPairingStatusReads >= 2,
                    phase: newlySavedPairingStatusReads >= 2 ? 'connected' : 'pairing',
                    hasToken: false,
                    activeConversations: 0
                  }
                ]
              : []),
            {
              id: 'chn_mocklegacy',
              type: 'legacy-chat',
              enabled: false,
              connected: false,
              phase: 'disabled',
              hasToken: true,
              activeConversations: 0
            }
          ]
        })
      );
    }
    if (method === 'PUT' && /^\/v1\/settings\/channels\/[^/]+\/credential$/.test(path)) {
      requests.push({ body: request.postDataJSON(), method, path });
      return route.fulfill(json({ ok: true }));
    }
    if (method === 'POST' && /^\/v1\/settings\/channels\/[^/]+\/login$/.test(path)) {
      requests.push({ method, path });
      return route.fulfill(json({ ok: true }));
    }
    if (method === 'PUT' && /^\/v1\/settings\/channels\/[^/]+$/.test(path)) {
      const body = request.postDataJSON() as { channel?: { id?: string; label?: string; type?: string } };
      requests.push({ body, method, path });
      if (body.channel?.type === 'whatsapp' && body.channel.label === 'Support inbox' && body.channel.id) {
        newlySavedPairingId = body.channel.id;
        newlySavedPairingStatusReads = 0;
      }
      return route.fulfill(json({ ok: true }));
    }
    if (method === 'GET' && path === '/v1/atoms/wa/update') {
      return route.fulfill(
        json({
          name: 'wa',
          source: 'local:/tmp/wa-pack',
          sourceKind: 'local',
          currentVersion: '1.0.0',
          latestVersion: '2.0.0',
          currentRevision: 'old-revision',
          latestRevision: 'new-revision',
          hasUpdate: true
        })
      );
    }
    if (method === 'POST' && path === '/v1/atoms/wa/update') {
      requests.push({ method, path });
      return route.fulfill(json({ name: 'wa', atoms: ['channel'], warnings: [] }));
    }
    if (method === 'POST' && path === '/v1/atoms/install') {
      requests.push({ body: request.postDataJSON(), method, path });
      return route.fulfill(json({ name: 'example-pack', atoms: ['tool'], warnings: [] }));
    }
    if (method === 'POST' && path === '/v1/system/pick-directory') {
      requests.push({ body: request.postDataJSON(), method, path });
      return route.fulfill(json({ path: '/tmp/local-atom-pack' }));
    }

    if (method === 'GET' && path === '/health') {
      return route.fulfill(json({ status: 'ok', version: '0.1.1', latestVersion: '0.1.1' }));
    }
    if (method === 'GET' && path === '/v1/init/status') {
      return route.fulfill(json({ initialized: true, missing: [], homePath: '/tmp/monad-e2e-home' }));
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
    if (method === 'GET' && path === '/v1/settings/model/roles') {
      return route.fulfill(json({ roles: {} }));
    }
    if (method === 'GET' && path === '/v1/agents') {
      return route.fulfill(
        json({
          agents: [
            {
              id: 'agt_mock00000000',
              name: 'Builder',
              capabilities: [],
              credentialIds: [],
              declaredScopes: [],
              memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 },
              visibility: { subagentCallable: false, public: false },
              a2a: { enabled: false },
              monadix: { consume: false },
              hasPrompt: true
            }
          ]
        })
      );
    }
    if (method === 'GET' && path === '/v1/agents/agt_mock00000000') {
      return route.fulfill(
        json({
          agent: {
            id: 'agt_mock00000000',
            name: 'Builder',
            capabilities: [],
            credentialIds: [],
            declaredScopes: [],
            memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 },
            visibility: { subagentCallable: false, public: false },
            a2a: { enabled: false },
            monadix: { consume: false },
            hasPrompt: true
          }
        })
      );
    }
    if (method === 'GET' && path === '/v1/settings/appearance')
      return route.fulfill(json({ avatarStyle: 'identicon' }));
    if (method === 'GET' && path === '/v1/memory/status') {
      return route.fulfill(json({ backend: 'builtin', projects: [] }));
    }
    if (method === 'GET' && path === '/v1/memory/facts') {
      return route.fulfill(json({ facts: [], nextCursor: null }));
    }
    if (method === 'GET' && path === '/v1/graph') return route.fulfill(json({ nodes: [], edges: [] }));
    if (method === 'GET' && path === '/v1/memory/laws') return route.fulfill(json({ laws: [] }));
    if (method === 'GET' && path === '/v1/settings/credentials') {
      return route.fulfill(json({ credentials: [] }));
    }
    if (method === 'GET' && path === '/v1/stats') {
      return route.fulfill(
        json({
          range: url.searchParams.get('range') ?? 'all',
          sessions: 3,
          messages: 12,
          totalTokens: 123456,
          activeDays: 4,
          currentStreak: 2,
          longestStreak: 3,
          peakHour: 14,
          favoriteModel: 'gpt-4.1',
          heatmap: [{ day: '2026-07-03', totalTokens: 123456 }],
          models: [
            {
              provider: 'openai',
              model: 'gpt-4.1',
              inputTokens: 80000,
              outputTokens: 30000,
              totalTokens: 123456,
              pct: 100
            }
          ]
        })
      );
    }
    if (method === 'GET' && path === '/v1/usage') {
      return route.fulfill(
        json({
          total: 1,
          limit: 50,
          offset: 0,
          totalCostUsd: 1.23,
          totalInputTokens: 80000,
          totalOutputTokens: 30000,
          entries: [
            {
              provider: 'openai',
              model: 'gpt-4.1',
              inputTokens: 80000,
              outputTokens: 30000,
              cacheReadTokens: 9000,
              cacheWriteTokens: 4000,
              reasoningTokens: 456,
              costUsd: 1.23,
              updatedAt: '2026-07-03T00:00:00.000Z'
            }
          ],
          breakdown: [
            {
              day: '2026-07-03',
              provider: 'openai',
              model: 'gpt-4.1',
              category: 'chat',
              inputTokens: 80000,
              outputTokens: 30000,
              cacheReadTokens: 9000,
              cacheWriteTokens: 4000,
              reasoningTokens: 456,
              costUsd: 1.23,
              updatedAt: '2026-07-03T00:00:00.000Z'
            }
          ]
        })
      );
    }
    if (method === 'POST' && path === '/v1/usage/reset') return route.fulfill(json({ ok: true }));
    if (method === 'GET' && path === '/v1/workplace/projects') {
      return route.fulfill(
        json({
          projects: [
            {
              archived: false,
              createdAt: '2026-07-03T00:00:00.000Z',
              cwd: '/tmp/mock-workplace',
              id: 'prj_mock00000000',
              state: 'ready',
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
    if (method === 'GET' && path === '/v1/mesh/agents') {
      return route.fulfill(
        json({
          agents: [
            {
              name: 'codex',
              label: 'Codex',
              provider: 'codex',
              command: 'codex',
              args: [],
              enabled: true,
              approvalOwnership: 'provider',
              runtimeRole: 'workplace',
              capabilities: {
                filesystem: true,
                shell: true,
                browser: false,
                approvals: true
              }
            }
          ]
        })
      );
    }
    if (method === 'GET' && path === '/v1/mesh/agents/presets') {
      return route.fulfill(json({ presets: [] }));
    }
    if (method === 'GET' && path === '/v1/mesh/usage') {
      return route.fulfill(
        json({
          checkedAt: '2026-07-03T00:00:00.000Z',
          providerUsage: [
            {
              agentName: 'codex',
              provider: 'codex',
              checkedAt: '2026-07-03T00:00:00.000Z',
              records: [{ name: '5h tokens', current: 21000, max: 100000, resetAt: '2026-07-03T05:00:00.000Z' }]
            }
          ],
          sessionUsage: [
            {
              meshSessionId: 'mesh_studioia0001',
              sessionId: 'ses_studioia0001',
              sessionTitle: 'Builder session',
              projectId: 'prj_studioia0001',
              projectMemberId: 'pmem_studioia0001',
              agentName: 'pmem_studioia0001',
              agentDisplayName: 'Builder',
              provider: 'codex',
              checkedAt: '2026-07-03T00:00:00.000Z',
              total: 110000,
              input: 80000,
              output: 30000
            }
          ]
        })
      );
    }
    if (method === 'GET' && path === '/v1/mesh/agents/codex/usage') {
      return route.fulfill(
        json({
          agentName: 'codex',
          provider: 'codex',
          checkedAt: '2026-07-03T00:00:00.000Z',
          records: [{ name: '5h tokens', current: 21000, max: 100000, resetAt: '2026-07-03T05:00:00.000Z' }]
        })
      );
    }

    return route.fulfill(json({}));
  });
}

test.describe('Studio IA', () => {
  test('opens on a beginner-friendly Runtime overview with advanced settings collapsed', async ({ page }) => {
    await installStudioIaApiMock(page);

    await page.goto('/studio/runtime');

    await expect(page.getByRole('heading', { name: 'Runtime overview' })).toBeVisible();
    const studioGroups = await page
      .locator('.sidebar-scroll-area')
      .filter({ hasText: 'Monad Agent Runtime' })
      .locator(':scope > div')
      .allTextContents();
    expect(studioGroups).toEqual([expect.stringMatching(/^Monad Mesh/), expect.stringMatching(/^Monad Agent Runtime/)]);
    await expect(page.getByText('Monad Mesh', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Set up Monad Agent Runtime' })).toBeVisible();
    await expect(page.getByTestId('studio-runtime-illustration')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Review credentials' })).toHaveAttribute('href', '/studio/credentials');

    const advanced = page.locator('details').filter({ hasText: 'Advanced runtime settings' });
    await expect(advanced).toBeVisible();
    await expect(advanced.getByRole('link', { name: 'Capabilities' })).toBeHidden();

    await advanced.getByText('Show').click();
    await expect(advanced.getByRole('link', { name: 'Capabilities' })).toBeVisible();
    await expect(advanced.getByRole('link', { name: 'ACP delegates' })).toBeVisible();
    await expect(advanced.getByRole('link', { name: 'Safety' })).toBeVisible();
    await expect(advanced.getByRole('link', { name: 'Hooks' })).toBeVisible();

    await advanced.getByRole('link', { name: 'Safety' }).click();
    await expect(page).toHaveURL(/\/studio\/safety$/);
    await expect(page.getByRole('heading', { name: 'Runtime safety controls' })).toBeVisible();
    // presence-ok: navigating to Safety must exclude the separately routed Hooks editor from Safety controls.
    await expect(page.locator('main').getByRole('link', { name: 'Hooks' })).toHaveCount(0);
  });

  test('moves Mesh-owned work out of Runtime into its own overview', async ({ page }) => {
    await installStudioIaApiMock(page);

    await page.goto('/studio/runtime');
    await page.getByRole('link', { name: 'Open Mesh overview' }).first().click();

    await expect(page).toHaveURL(/\/studio\/mesh$/);
    await expect(page.getByRole('heading', { name: 'Mesh overview' })).toBeVisible();
    await expect(
      page.getByText('Normalized provider, agent, project, and session snapshots are stored locally.')
    ).toBeVisible();
    await expect(page.getByText('Monad Mesh', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Project members' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Tasks and sessions' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Details', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'By provider' })).toBeVisible();
    await expect(page.getByText('110.0K').first()).toBeVisible();
  });

  test('configures every installed channel adapter from the System Channels tab', async ({ page }) => {
    const requests: Array<{ body?: unknown; method: string; path: string }> = [];
    await installStudioIaApiMock(page, requests);
    await page.goto('/studio/runtime');

    await page.getByRole('link', { name: 'Channels' }).click();
    await expect(page).toHaveURL(/\/studio\/channels$/);

    const adapter = page.locator('section.rounded-lg').filter({ hasText: 'WhatsApp' }).first();
    await expect(adapter.getByText('2 connections')).toBeVisible();
    await expect(adapter.getByRole('button', { name: 'WhatsApp inbox chn_mockwhatsapp' })).toBeVisible();
    await expect(adapter.getByRole('button', { name: 'WhatsApp alerts chn_mockwhatsappalerts' })).toBeVisible();
    // behavior-ok: creation is scoped to each installed adapter, not a global header action.
    await expect(page.getByRole('button', { name: 'Add channel' })).toHaveCount(0);

    expect(requests.filter((request) => request.path === '/v1/settings/channels/status')).toHaveLength(1);
    await page.waitForTimeout(2300);
    expect(requests.filter((request) => request.path === '/v1/settings/channels/status').length).toBeGreaterThanOrEqual(
      3
    );

    await page.getByRole('button', { name: 'Collapse all', exact: true }).click();
    await expect(adapter.getByRole('button', { name: 'WhatsApp inbox chn_mockwhatsapp' })).toBeHidden();
    await page.getByRole('button', { name: 'Expand all', exact: true }).click();
    await expect(adapter.getByRole('button', { name: 'WhatsApp inbox chn_mockwhatsapp' })).toBeVisible();

    const unavailable = page.locator('section.rounded-lg').filter({ hasText: 'legacy-chat' }).first();
    await expect(unavailable.getByText(/no longer installed/)).toBeVisible();
    await expect(unavailable.getByRole('button', { name: 'Add connection' })).toBeDisabled();
    await expect(unavailable.getByRole('switch', { name: 'Turn Legacy inbox on or off' })).toBeDisabled();

    await adapter.getByRole('switch', { name: 'Turn WhatsApp inbox on or off' }).click();
    await expect
      .poll(
        () =>
          requests.find(
            (request) => request.path === '/v1/settings/channels/chn_mockwhatsapp' && request.method === 'PUT'
          )?.body
      )
      .toEqual({
        channel: {
          id: 'chn_mockwhatsapp',
          type: 'whatsapp',
          label: 'WhatsApp inbox',
          enabled: true,
          mapping: { granularity: 'per-conversation' },
          rateLimitPerMin: 20
        }
      });

    await adapter.getByRole('button', { name: 'Edit WhatsApp inbox' }).click();
    const editDialog = page.getByRole('dialog', { name: 'Edit connection' });
    await expect(editDialog.getByRole('textbox', { name: 'WHATSAPP_ACCESS_TOKEN' })).toHaveCount(0);
    await editDialog.getByRole('button', { name: 'Pair again' }).click();
    await expect
      .poll(() => requests.find((request) => request.path === '/v1/settings/channels/chn_mockwhatsapp/login')?.method)
      .toBe('POST');
    await editDialog.getByRole('button', { name: 'Cancel' }).click();

    await adapter.getByRole('button', { name: 'Add connection' }).click();
    const addDialog = page.getByRole('dialog', { name: 'Add connection' });
    await expect(addDialog.getByRole('heading', { name: 'How to connect' })).toBeVisible();
    await expect(addDialog.getByText('Open Linked Devices.')).toBeVisible();
    await expect(addDialog.getByRole('link', { name: 'Open official setup guide' })).toHaveAttribute(
      'href',
      'https://faq.whatsapp.com/1317564962315842'
    );
    await addDialog.getByRole('textbox', { name: 'Label' }).fill('Support inbox');
    await addDialog.getByRole('button', { name: 'Save and pair', exact: true }).click();

    await expect
      .poll(
        () =>
          requests.find(
            (request) =>
              request.method === 'PUT' &&
              !request.path.endsWith('/credential') &&
              (request.body as { channel?: { label?: string } } | undefined)?.channel?.label === 'Support inbox'
          )?.body
      )
      .toEqual({
        channel: {
          id: expect.stringMatching(/^chn_/),
          type: 'whatsapp',
          label: 'Support inbox',
          enabled: true,
          groupPolicy: { requireMention: true },
          mapping: { granularity: 'per-conversation' },
          rateLimitPerMin: 20
        }
      });
    expect(requests.some((request) => request.path.endsWith('/credential'))).toBe(false);
    await expect(page.getByRole('dialog', { name: 'Edit connection' })).toBeHidden();

    await adapter.locator('button[aria-expanded="true"]').click();
    // behavior-ok: collapsing an adapter hides its connection controls while keeping the adapter row available.
    await expect(adapter.getByRole('button', { name: 'WhatsApp inbox chn_mockwhatsapp' })).toBeHidden();
  });

  test('scrolls the flat channel list inside the fixed Studio shell', async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 280 });
    await installStudioIaApiMock(page);
    await page.goto('/studio/channels');

    const scrollArea = page.getByTestId('channels-scroll-area');
    await expect.poll(() => scrollArea.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await scrollArea.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect.poll(() => scrollArea.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  });

  test('embeds Monad agent usage under the Agents surface', async ({ page }) => {
    await installStudioIaApiMock(page);

    await page.goto('/studio/agents');

    await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Monad agent usage' })).toBeVisible();
    await expect(page.getByText('gpt-4.1')).toBeVisible();
    await expect(page.getByText('$1.23')).toBeVisible();
  });

  test('opens Agent details before edit and preserves Session and Memory tab URLs', async ({ page }) => {
    await installStudioIaApiMock(page);
    await page.goto('/studio/agents');

    await page.getByRole('button', { name: 'Builder' }).click();
    await expect(page).toHaveURL(/\/studio\/agents\/agt_mock00000000$/);
    await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Project', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Monadix', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Project', exact: true }).click();
    await expect(page).toHaveURL(/\/studio\/agents\/agt_mock00000000\/sessions\/project$/);
    await page.reload();
    await expect(page).toHaveURL(/\/studio\/agents\/agt_mock00000000\/sessions\/project$/);

    await page.getByRole('tab', { name: 'Memory', exact: true }).click();
    await expect(page).toHaveURL(/\/studio\/agents\/agt_mock00000000\/memory\/facts$/);
    await expect(page.getByRole('button', { name: 'Facts', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Graph', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Laws', exact: true })).toBeVisible();
  });

  test('keeps consolidation controls scoped to each Agent on global Memory settings', async ({ page }) => {
    await installStudioIaApiMock(page);
    await page.goto('/studio/memory');

    await expect(page.getByRole('heading', { name: 'Memory' })).toBeVisible();
    await expect(page.getByText('Builder', { exact: true })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Auto-consolidate' })).toHaveCount(1);
    await expect(page.getByRole('spinbutton', { name: 'Interval (minutes)' })).toBeDisabled();
  });

  test('updates an eligible Atom Pack only after explicit confirmation', async ({ page }) => {
    const requests: Array<{ method: string; path: string }> = [];
    await installStudioIaApiMock(page, requests);
    await page.goto('/studio/atoms');

    const update = page.getByRole('button', { name: 'Check for updates' });
    await update.click();
    expect(requests).toEqual([]);
    await expect(page.getByRole('alertdialog')).toContainText('local:/tmp/wa-pack');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(requests).toEqual([]);

    await update.click();
    await page.getByRole('button', { name: 'Update Atom Pack' }).click();
    await expect.poll(() => requests).toEqual([{ method: 'POST', path: '/v1/atoms/wa/update' }]);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);

    const manualPack = page.locator('div.rounded-md.border').filter({ hasText: 'Manual Pack' });
    // presence-ok: daemon eligibility suppresses the update action on the ineligible card.
    await expect(manualPack.getByRole('button', { name: 'Check for updates' })).toHaveCount(0);
  });

  test('installs an Atom Pack from a modal', async ({ page }) => {
    const requests: Array<{ method: string; path: string }> = [];
    await installStudioIaApiMock(page, requests);
    await page.goto('/studio/atoms');

    await page.getByRole('button', { name: 'Install Atom Pack' }).click();
    const dialog = page.getByRole('dialog', { name: 'Install an atom' });
    await dialog.getByRole('textbox', { name: 'Source' }).fill('github:owner/example@sha');
    await dialog.getByRole('button', { name: 'Install', exact: true }).click();

    await expect
      .poll(() => requests)
      .toContainEqual({
        body: { consent: false, source: 'github:owner/example@sha' },
        method: 'POST',
        path: '/v1/atoms/install'
      });
    // behavior-ok: a successful install closes the modal.
    await expect(dialog).toHaveCount(0);
  });

  test('chooses a local Atom Pack with the host folder picker before installing', async ({ page }) => {
    const requests: Array<{ body?: unknown; method: string; path: string }> = [];
    await installStudioIaApiMock(page, requests);
    await page.goto('/studio/atoms');

    await page.getByRole('button', { name: 'Install Atom Pack' }).click();
    const dialog = page.getByRole('dialog', { name: 'Install an atom' });
    await dialog.getByRole('button', { name: 'Local development folder' }).click();

    await expect(dialog.getByRole('textbox', { name: 'Source' })).toHaveValue('/tmp/local-atom-pack');
    await dialog.getByRole('button', { name: 'Install', exact: true }).click();

    await expect
      .poll(() => requests)
      .toEqual([
        {
          body: { prompt: 'Choose folder' },
          method: 'POST',
          path: '/v1/system/pick-directory'
        },
        {
          body: { consent: false, source: 'local:/tmp/local-atom-pack' },
          method: 'POST',
          path: '/v1/atoms/install'
        }
      ]);
    await expect(dialog).toHaveCount(0);
  });
});
