import { expect, type Page, test } from '@playwright/test';

async function installImportApiMock(page: Page) {
  let applyPayload: unknown = null;

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
    if (method === 'GET' && path === '/v1/sessions') return json({ sessions: [], total: 0, limit: 50, offset: 0 });
    if (method === 'GET' && path === '/v1/workplace/projects') return json({ projects: [] });
    if (method === 'GET' && path === '/v1/commands') return json({ commands: [] });
    if (method === 'GET' && path === '/v1/settings/model/profiles') return json({ profiles: [], defaultAlias: '' });
    if (method === 'GET' && path === '/v1/settings/model/roles') return json({ roles: {} });
    if (method === 'GET' && path === '/v1/settings/locale') return json({ locale: 'en' });
    if (method === 'GET' && path === '/v1/settings/locales') {
      return json({ locales: [{ locale: 'en', label: 'English', source: 'built-in' }] });
    }
    if (method === 'GET' && path === '/v1/settings/appearance') {
      return json({ theme: 'system', assistantAvatarStyle: 'initials', userAvatarStyle: 'initials' });
    }
    if (method === 'GET' && path === '/v1/i18n/catalog') return json({ locale: 'en', messages: {} });
    if (method === 'GET' && path === '/v1/settings/network') {
      return json({
        port: 3201,
        transport: 'tcp',
        https: { enabled: true },
        remoteAccess: { enabled: false, token: '' },
        localHttpFallback: { enabled: false, port: 3202 }
      });
    }

    if (method === 'GET' && path === '/v1/settings/capability-inventory') {
      return json({
        roots: [
          {
            source: 'codex',
            sourceLabel: 'Codex',
            scope: 'user',
            kind: 'mcpServers',
            path: '/home/test/.codex/config.toml',
            exists: true,
            shared: false
          },
          {
            source: 'codex',
            sourceLabel: 'Codex',
            scope: 'user',
            kind: 'skills',
            path: '/home/test/.codex/skills',
            exists: true,
            shared: false
          },
          {
            source: 'claude-code',
            sourceLabel: 'Claude Code',
            scope: 'user',
            kind: 'agents',
            path: '/home/test/.claude/agents',
            exists: true,
            shared: false
          }
        ],
        items: [
          {
            id: 'mcp:codex:user:browser',
            kind: 'mcpServer',
            name: 'browser',
            source: 'codex',
            sourceLabel: 'Codex',
            scope: 'user',
            path: '/home/test/.codex/config.toml',
            shared: false,
            hash: 'sha256-browser',
            warnings: [],
            transport: 'stdio',
            command: 'npx'
          },
          {
            id: 'skill:codex:user:reviewer',
            kind: 'skill',
            name: 'reviewer',
            source: 'codex',
            sourceLabel: 'Codex',
            scope: 'user',
            path: '/home/test/.codex/skills/reviewer',
            shared: false,
            hash: 'sha256-reviewer',
            warnings: []
          },
          {
            id: 'agent:claude-code:user:writer',
            kind: 'agent',
            name: 'writer',
            source: 'claude-code',
            sourceLabel: 'Claude Code',
            scope: 'user',
            path: '/home/test/.claude/agents/writer.md',
            shared: false,
            hash: 'sha256-writer',
            warnings: []
          }
        ],
        warnings: []
      });
    }

    if (method === 'POST' && path === '/v1/settings/import/preview') {
      const body = request.postDataJSON() as { from: string; path: string };
      return json({
        from: body.from,
        path: body.path,
        items: [
          {
            id: 'mcpServers:browser',
            hash: 'hash-browser',
            category: 'mcpServers',
            source: `${body.path}/config.toml:mcp_servers.browser`,
            target: 'browser',
            action: 'add',
            reason: 'Codex MCP server maps to Monad MCP servers.',
            risk: 'medium',
            summary: 'npx @browser/mcp'
          },
          {
            id: 'approvals:policy',
            hash: 'hash-policy',
            category: 'approvals',
            source: `${body.path}/config.toml:approval_policy`,
            target: 'agent.approvals',
            action: 'manual',
            reason: 'Approval policy requires manual review before Monad can map it.',
            risk: 'high'
          }
        ],
        warnings: []
      });
    }

    if (method === 'POST' && path === '/v1/settings/import/apply') {
      applyPayload = request.postDataJSON();
      const body = applyPayload as { from: string; path: string };
      return json({
        applied: ['mcpServers:browser'],
        skipped: [],
        preview: {
          from: body.from,
          path: body.path,
          items: [],
          warnings: []
        }
      });
    }

    return json({});
  });

  return {
    getApplyPayload: () => applyPayload
  };
}

test('Studio import previews one detected agent and applies selected resources only', async ({ page }) => {
  const apiMock = await installImportApiMock(page);

  await page.goto('/studio/import');

  await expect(page.getByRole('heading', { name: 'Detected agent import' })).toBeVisible();
  const detectedAgents = page.locator('aside').filter({ hasText: 'Detected agents' });
  await expect(detectedAgents.getByRole('button', { name: /Codex/ })).toBeVisible();
  await expect(detectedAgents.getByRole('button', { name: /Claude Code/ })).toBeVisible();
  await expect(page.locator('div').filter({ hasText: /^Detected source\/home\/test\/\.codex$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /browser add medium/ })).toBeVisible();

  const applyButton = page.getByRole('button', { name: 'Apply selected' });
  await expect(applyButton).toBeDisabled();

  await page.getByLabel('Include browser').check();
  await expect(page.getByText('1 selected · 1 applyable')).toBeVisible();
  await expect(applyButton).toBeEnabled();

  await applyButton.click();
  await expect(page.getByText('1 applied, 0 skipped.')).toBeVisible();

  const payload = apiMock.getApplyPayload();
  expect(payload).toMatchObject({
    from: 'codex',
    path: '/home/test/.codex',
    select: ['mcpServers:browser'],
    allSafe: false
  });
});
