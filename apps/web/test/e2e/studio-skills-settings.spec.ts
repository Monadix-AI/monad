import { expect, type Page, test } from '@playwright/test';

type SkillSettings = {
  autoload: boolean;
  disabled: string[];
  autoloadDisabled: string[];
  installReview: boolean;
  installReviewAvailable: boolean;
};

type RequestLog = { method: string; path: string; search: string; body: unknown; contentType: string | null };

const skillContent = `---
name: codegraph-navigator
description: Navigate CodeGraph indexes before fallback search.
---

Use CodeGraph first when the repository is indexed.
`;

function baseSettings(): SkillSettings {
  return {
    autoload: true,
    disabled: [],
    autoloadDisabled: ['atom-pack:qa'],
    installReview: false,
    installReviewAvailable: true
  };
}

function installedSkills() {
  return {
    skills: [
      {
        name: 'CodeGraph Navigator',
        version: '1.2.3',
        icon: 'CG',
        source: 'github:monadix-labs/codegraph-navigator@main',
        commit: '1234567890abcdef',
        installedAt: '2026-06-20T12:00:00.000Z'
      }
    ]
  };
}

function skillInstances() {
  return {
    skills: [],
    skillInstances: [
      {
        id: 'global:codegraph',
        name: 'CodeGraph Navigator',
        description: 'Navigate indexed code before falling back to text search.',
        version: '1.2.3',
        icon: 'CG',
        userInvocable: true,
        available: true,
        sourceKind: 'global',
        sourceId: 'global',
        source: 'User install',
        active: true
      },
      {
        id: 'atom-pack:qa',
        name: 'QA Checklist',
        description: 'Run a repeatable verification checklist from an atom pack.',
        version: '0.4.0',
        userInvocable: true,
        available: false,
        unavailable: ['bin:playwright'],
        sourceKind: 'atom-pack',
        sourceId: 'qa-tools',
        source: 'Atom Pack: qa-tools',
        active: true
      }
    ]
  };
}

async function installSkillsApiMock(
  page: Page,
  options: { empty?: boolean } = {}
): Promise<{ requests: RequestLog[]; settings: SkillSettings }> {
  const requests: RequestLog[] = [];
  const settings = baseSettings();
  let liveSkills = options.empty ? { skills: [], skillInstances: [] } : skillInstances();
  let installed = options.empty ? { skills: [] } : installedSkills();

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!(url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/') || url.pathname === '/health')) {
      return route.continue();
    }
    const path = url.pathname.replace('/api/v1', '/v1').replace('/api/health', '/health');
    const method = request.method();
    const contentType = request.headers()['content-type'] ?? null;
    const body =
      method === 'GET' ? undefined : contentType?.includes('json') ? request.postDataJSON() : request.postData();
    requests.push({ method, path, search: url.search, body, contentType });

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
    if (method === 'GET' && (path === '/v1/native-cli-runtimes' || path === '/v1/native-cli-session-summaries')) {
      return json({ sessions: [] });
    }
    if (method === 'GET' && path === '/v1/settings/model/profiles') {
      return json({ profiles: [], defaultAlias: '' });
    }
    if (method === 'GET' && path === '/v1/settings/model/roles') return json({ roles: {} });
    if (method === 'GET' && path === '/v1/settings/locale') return json({ locale: 'en' });
    if (method === 'GET' && path === '/v1/settings/locales') {
      return json({ locales: [{ locale: 'en', label: 'English', source: 'built-in' }] });
    }
    if (method === 'GET' && path === '/v1/i18n/catalog') return json({ locale: 'en', messages: {} });

    if (method === 'GET' && path === '/v1/settings/skills') return json(settings);
    if (method === 'PUT' && path === '/v1/settings/skills') {
      Object.assign(settings, (await request.postDataJSON()) as Partial<SkillSettings>);
      return json(settings);
    }

    if (method === 'GET' && path === '/v1/atoms/skills') return json(installed);
    if (method === 'GET' && path === '/v1/skills') return json(liveSkills);
    if (method === 'GET' && path === '/v1/atoms/skills/updates') {
      return json({
        updates: [{ name: 'CodeGraph Navigator', ref: 'main', current: '1234567', latest: 'abcdef0', hasUpdate: true }]
      });
    }

    if (method === 'GET' && path === '/v1/atoms/skills/CodeGraph%20Navigator/content' && url.searchParams.get('file')) {
      return json({
        name: 'codegraph-navigator',
        content: '# Reference guide',
        encoding: 'utf8',
        file: url.searchParams.get('file'),
        preview: 'text',
        files: []
      });
    }
    if (method === 'GET' && path === '/v1/atoms/skills/CodeGraph%20Navigator/content') {
      return json({
        name: 'codegraph-navigator',
        content: skillContent,
        encoding: 'utf8',
        preview: 'text',
        files: [
          { path: 'references/guide.md', size: 84, preview: 'text', language: 'markdown', contentType: 'text/markdown' }
        ]
      });
    }
    if (method === 'PUT' && path === '/v1/atoms/skills/CodeGraph%20Navigator/content') {
      return json({ name: 'codegraph-navigator', dir: '/tmp/codegraph-navigator', warnings: [] });
    }
    if (method === 'PUT' && path === '/v1/atoms/skills/codegraph-navigator/content') {
      const payload = (await request.postDataJSON()) as { content?: string };
      if (payload.content?.includes('reject update')) {
        return json({ error: 'save failed' }, 500);
      }
      return json({ name: 'codegraph-navigator', dir: '/tmp/codegraph-navigator', warnings: [] });
    }
    if (method === 'DELETE' && path === '/v1/atoms/skills/CodeGraph%20Navigator') {
      installed = { skills: [] };
      liveSkills = {
        skills: [],
        skillInstances: liveSkills.skillInstances.filter((skill) => skill.id !== 'global:codegraph')
      };
      return json({ ok: true });
    }
    if (method === 'POST' && path === '/v1/atoms/skills/CodeGraph%20Navigator/update') {
      return json({ skills: ['CodeGraph Navigator'], commit: 'abcdef0', warnings: [] });
    }
    if (
      method === 'POST' &&
      path === '/v1/atoms/skills/upload' &&
      url.searchParams.get('filename') === 'invalid-skill.md'
    ) {
      return json({ error: 'invalid SKILL.md' }, 422);
    }
    if (
      method === 'POST' &&
      path === '/v1/atoms/skills/upload' &&
      url.searchParams.get('filename') === 'SKILL.md' &&
      request.postData()?.includes('api-rejected-skill')
    ) {
      return json({ error: 'invalid SKILL.md' }, 422);
    }
    if (method === 'POST' && path === '/v1/atoms/skills/upload') {
      return json({ skills: ['Uploaded Skill'], commit: '', warnings: [] });
    }
    if (method === 'POST' && path === '/v1/atoms/skills/install') {
      const payload = (await request.postDataJSON()) as { consent?: boolean; source?: string };
      if (payload.source === 'github:monadix-labs/failing-skill') {
        return json({ error: 'install failed' }, 500);
      }
      if (!payload.consent) {
        return json({
          skills: ['Marketplace Scout'],
          commit: '',
          needsConsent: true,
          warnings: ['Uses remote instructions']
        });
      }
      return json({ skills: ['Marketplace Scout'], commit: 'feedbee', warnings: [] });
    }

    if (method === 'GET' && path === '/v1/skills/browse') {
      return json({
        results: [
          {
            id: 'marketplace-scout',
            source: 'clawhub',
            name: 'Marketplace Scout',
            description: 'Find promising skills from curated sources.',
            score: 0.97,
            version: '0.9.0',
            downloads: 1400,
            homepage: 'https://example.com/scout',
            installSource: null
          }
        ],
        query: '',
        sort: url.searchParams.get('sort') ?? 'trending',
        source: url.searchParams.get('source') ?? 'clawhub'
      });
    }
    if (method === 'GET' && path === '/v1/skills/search') {
      return json({
        results: [
          {
            id: 'marketplace-scout',
            source: 'clawhub',
            name: 'Marketplace Scout',
            description: 'Find promising skills from curated sources.',
            score: 0.99,
            version: '0.9.0',
            downloads: 1400,
            homepage: 'https://example.com/scout',
            installSource: null
          }
        ],
        query: url.searchParams.get('q') ?? '',
        source: url.searchParams.get('source') ?? 'clawhub'
      });
    }
    if (method === 'GET' && path === '/v1/skills/marketplace-scout') {
      return json({
        id: 'marketplace-scout',
        source: 'clawhub',
        name: 'Marketplace Scout',
        summary: 'Find promising skills from curated sources.',
        content: '## Marketplace Scout\n\nUseful installable workflow.',
        downloads: 1400,
        version: '0.9.0',
        homepage: 'https://example.com/scout',
        installSource: null
      });
    }

    return json({});
  });

  return { requests, settings };
}

async function openSkills(page: Page) {
  await page.goto('/studio/skills');
  await expect(page.getByRole('heading', { name: 'Skills', exact: true })).toBeVisible();
  await expect(page.getByText('CodeGraph Navigator').or(page.getByText('No skills installed yet.'))).toBeVisible();
}

test.describe('Studio skills settings', () => {
  test('removes a deleted global skill from the installed list', async ({ page }) => {
    const { requests } = await installSkillsApiMock(page);
    await openSkills(page);

    const skillCard = page.locator('article').filter({ hasText: 'CodeGraph Navigator' });
    await skillCard.hover();
    await skillCard.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('Remove this skill?')).toBeVisible();
    await page.getByRole('button', { name: 'Remove' }).last().click();

    expect(
      requests.some(
        (request) => request.method === 'DELETE' && request.path === '/v1/atoms/skills/CodeGraph%20Navigator'
      )
    ).toBe(true);
    await expect(page.getByText('CodeGraph Navigator')).toBeHidden();
    await expect(page.getByText('QA Checklist')).toBeVisible();
  });

  test('reveals installed skill actions only when the card is hovered', async ({ page }) => {
    await installSkillsApiMock(page);
    await openSkills(page);

    const skillCard = page.locator('article').filter({ hasText: 'CodeGraph Navigator' });
    const actions = skillCard.locator('[data-slot="skill-card-actions"]');

    await expect(actions).toHaveCSS('opacity', '0');
    await skillCard.hover();
    await expect(actions).toHaveCSS('opacity', '1');
  });

  test('covers installed settings, card controls, updates, edit, remove, and add menu flows', async ({ page }) => {
    const { requests, settings } = await installSkillsApiMock(page);
    await openSkills(page);

    await expect(page.getByText('1/2 Enabled')).toBeVisible();
    await expect(page.getByText('Global skills')).toBeVisible();
    await expect(page.getByText('Atom Pack skills')).toBeVisible();
    await expect(page.getByText('CodeGraph Navigator')).toBeVisible();
    await expect(page.getByText('QA Checklist')).toBeVisible();
    const atomPackSkillCard = page.locator('article').filter({ hasText: 'QA Checklist' });
    await expect(atomPackSkillCard.getByText('From:')).toBeVisible();
    await expect(atomPackSkillCard.getByText('qa-tools')).toBeVisible();
    await expect(page.getByText('Unavailable')).toBeVisible();

    const globalAutoload = page.getByRole('switch', { name: 'Auto-load skills into context' });
    await expect(globalAutoload).toBeChecked();
    await globalAutoload.click();
    await expect(globalAutoload).not.toBeChecked();
    expect(settings.autoload).toBe(false);
    await expect(page.getByRole('switch', { name: 'Toggle auto-load for CodeGraph Navigator' })).toBeDisabled();

    await globalAutoload.click();
    await expect(globalAutoload).toBeChecked();
    await page.getByRole('switch', { name: 'Pre-install safety review' }).click();
    expect(settings.installReview).toBe(true);

    await page.getByRole('switch', { name: 'Toggle CodeGraph Navigator' }).click();
    await expect(page.getByRole('switch', { name: 'Toggle CodeGraph Navigator' })).not.toBeChecked();
    expect(settings.disabled).toContain('global:codegraph');
    await expect(page.getByRole('switch', { name: 'Toggle auto-load for CodeGraph Navigator' })).toBeDisabled();

    await page.getByRole('switch', { name: 'Toggle CodeGraph Navigator' }).click();
    await page.getByRole('switch', { name: 'Toggle auto-load for CodeGraph Navigator' }).click();
    await expect(page.getByRole('switch', { name: 'Toggle auto-load for CodeGraph Navigator' })).not.toBeChecked();
    expect(settings.autoloadDisabled).toContain('global:codegraph');

    const codegraphSkillCard = page.locator('article').filter({ hasText: 'CodeGraph Navigator' });
    await page.getByRole('button', { name: 'Check for updates' }).click();
    await codegraphSkillCard.hover();
    await expect(codegraphSkillCard.getByRole('button', { name: 'Update', exact: true })).toBeVisible();
    await codegraphSkillCard.getByRole('button', { name: 'Update', exact: true }).click();

    await page.getByRole('button', { name: 'GitHub metadata' }).click();
    await expect(page.getByText('monadix-labs/codegraph-navigator')).toBeVisible();
    await page.keyboard.press('Escape');

    await codegraphSkillCard.hover();
    await codegraphSkillCard.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByRole('dialog', { name: 'Edit CodeGraph Navigator' })).toBeVisible();
    await page.getByRole('button', { name: 'Preview' }).click();
    await expect(page.getByText('Use CodeGraph first when the repository is indexed.')).toBeVisible();
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.getByRole('textbox').fill(skillContent.replace('Use CodeGraph first', 'Always use CodeGraph first'));
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog', { name: 'Edit CodeGraph Navigator' })).toBeHidden();

    await codegraphSkillCard.hover();
    await codegraphSkillCard.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('Remove this skill?')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Remove this skill?')).toBeHidden();
    await codegraphSkillCard.hover();
    await codegraphSkillCard.getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('button', { name: 'Remove' }).last().click();
    await expect(page.getByText('CodeGraph Navigator')).toBeHidden();
    await expect(page.getByText('QA Checklist')).toBeVisible();

    await page.getByRole('main').getByRole('button', { name: 'Install skill' }).first().click();
    await page.getByText('Upload .md or .zip').click();
    const uploadDialog = page.getByRole('dialog', { name: 'Upload skill' });
    await expect(uploadDialog).toBeVisible();
    const fileChooser = page.waitForEvent('filechooser');
    await uploadDialog.getByRole('button', { name: /Drag and drop or click to upload/ }).click();
    await (await fileChooser).setFiles({
      name: 'uploaded-skill.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(`---
name: uploaded-skill
description: Uploaded through the e2e file picker.
---

Use this uploaded skill in e2e.
`)
    });
    await expect(page.getByRole('dialog', { name: 'Upload skill' })).toBeHidden();

    await page.getByRole('main').getByRole('button', { name: 'Install skill' }).first().click();
    await page.getByText('Edit SKILL.md').click();
    const newSkillDialog = page.getByRole('dialog', { name: 'New skill' });
    await expect(newSkillDialog).toBeVisible();
    await newSkillDialog.getByRole('textbox').fill(`---
name: editor-created-skill
description: Created through the e2e SKILL.md editor.
---

Use this editor-created skill in e2e.
`);
    await newSkillDialog.getByRole('button', { name: 'Save' }).click();
    await expect(newSkillDialog).toBeHidden();

    await page.getByRole('main').getByRole('button', { name: 'Install skill' }).first().click();
    await page.getByText('GitHub source').click();
    const githubDialog = page.getByRole('dialog', { name: 'Import from GitHub' });
    await expect(githubDialog).toBeVisible();
    await page
      .getByPlaceholder('https://github.com/username/repo')
      .fill('https://github.com/monadix-labs/marketplace-scout');
    await githubDialog.getByRole('button', { name: 'Install', exact: true }).last().click();
    await expect(page.getByText('This repo declares the following skills:')).toBeVisible();
    const consentButton = page
      .locator('[data-radix-popper-content-wrapper]')
      .getByRole('button', { name: 'Install with consent' });
    await expect(consentButton).toBeEnabled();
    await consentButton.click({ force: true });

    expect(requests.some((request) => request.method === 'POST' && request.path === '/v1/atoms/skills/install')).toBe(
      true
    );
    expect(
      requests.some(
        (request) => request.method === 'PUT' && request.path === '/v1/atoms/skills/codegraph-navigator/content'
      )
    ).toBe(true);
    expect(
      requests.some(
        (request) => request.method === 'DELETE' && request.path === '/v1/atoms/skills/CodeGraph%20Navigator'
      )
    ).toBe(true);
    const uploadRequests = requests.filter(
      (request) => request.method === 'POST' && request.path === '/v1/atoms/skills/upload'
    );
    expect(uploadRequests.map((request) => request.search).sort()).toEqual([
      '?filename=SKILL.md&overwrite=true',
      '?filename=uploaded-skill.md&overwrite=true'
    ]);
  });

  test('opens marketplace by route and syncs market selection into the URL', async ({ page }) => {
    await installSkillsApiMock(page);

    await page.goto('/studio/skills/marketplace/skills.sh');
    await expect(page.getByRole('heading', { name: 'Skills', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Installed' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'skills.sh' })).toHaveAttribute('aria-selected', 'true');

    await page.getByRole('tab', { name: 'ClawHub' }).click();
    await expect(page).toHaveURL(/\/studio\/skills\/marketplace\/clawhub$/);
  });

  test('covers marketplace, search, sort, detail, consent install, and return to installed list', async ({ page }) => {
    const { requests } = await installSkillsApiMock(page);
    await openSkills(page);

    await page.getByRole('main').getByRole('button', { name: 'Marketplace', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Installed' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'ClawHub' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'skills.sh' })).toBeVisible();
    await expect(page.getByText('Marketplace Scout')).toBeVisible();
    const marketplaceCard = page.locator('[data-slot="skill-browse-card"]').filter({ hasText: 'Marketplace Scout' });
    const marketplaceInstall = marketplaceCard.getByRole('button', { name: 'Install', exact: true });
    await expect(marketplaceInstall).toHaveCSS('opacity', '0');
    await marketplaceCard.hover();
    await expect(marketplaceInstall).toHaveCSS('opacity', '1');

    await page.getByRole('tab', { name: 'Top' }).click();
    await expect
      .poll(() => requests.some((request) => request.path === '/v1/skills/browse' && request.method === 'GET'))
      .toBe(true);

    await page.getByPlaceholder(/Search skills on ClawHub/).fill('scout');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Find promising skills from curated sources.')).toBeVisible();
    await expect.poll(() => requests.some((request) => request.path === '/v1/skills/search')).toBe(true);

    await page.getByRole('button', { name: 'Marketplace Scout' }).click();
    await expect(page.getByText('Useful installable workflow.')).toBeVisible();
    await page.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(page.getByText('This repo declares the following skills:')).toBeVisible();
    await expect(page.getByText('Skill install needs your consent.')).toBeVisible();
    await page.getByRole('button', { name: 'Installed' }).click();
    await expect(page.getByText('Skill install needs your consent.')).toBeVisible();
    await page.getByRole('button', { name: 'Install with consent' }).click();
    await expect(page.getByText('Skill installed.')).toBeVisible();
    await expect(page.getByText('Global skills')).toBeVisible();

    const installRequests = requests.filter((request) => request.path === '/v1/atoms/skills/install');
    expect(installRequests).toHaveLength(2);
    expect(installRequests[0].body).toMatchObject({ source: 'clawhub:marketplace-scout', consent: false });
    expect(installRequests[1].body).toMatchObject({ source: 'clawhub:marketplace-scout', consent: true });
  });

  test('covers invalid install inputs and rejected skill files', async ({ page }) => {
    const { requests } = await installSkillsApiMock(page);
    await openSkills(page);

    await page.getByRole('main').getByRole('button', { name: 'Install skill' }).first().click();
    await page.getByText('GitHub source').click();
    const githubDialog = page.getByRole('dialog', { name: 'Import from GitHub' });
    await expect(githubDialog.getByRole('button', { name: 'Install', exact: true }).last()).toBeDisabled();
    await githubDialog.getByPlaceholder('https://github.com/username/repo').fill('https://example.com/not-github');
    await githubDialog.getByRole('button', { name: 'Install', exact: true }).last().click();
    await expect(page.getByText('Enter a valid GitHub repository URL.')).toBeVisible();
    expect(
      requests.filter((request) => request.method === 'POST' && request.path === '/v1/atoms/skills/install')
    ).toHaveLength(0);

    await githubDialog
      .getByPlaceholder('https://github.com/username/repo')
      .fill('https://github.com/monadix-labs/failing-skill');
    await githubDialog.getByRole('button', { name: 'Install', exact: true }).last().click();
    await expect(page.getByText('Install failed.')).toBeVisible();
    await expect(githubDialog).toBeVisible();
    expect(
      requests.filter((request) => request.method === 'POST' && request.path === '/v1/atoms/skills/install')
    ).toHaveLength(1);
    await githubDialog.getByRole('button', { name: 'Close' }).click();
    await expect(githubDialog).toBeHidden();

    await page.getByRole('main').getByRole('button', { name: 'Install skill' }).first().click();
    await page.getByText('Edit SKILL.md').click();
    const newSkillDialog = page.getByRole('dialog', { name: 'New skill' });
    await expect(newSkillDialog.getByRole('button', { name: 'Save' })).toBeDisabled();
    await newSkillDialog.getByRole('textbox').fill('plain text without frontmatter');
    await newSkillDialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('SKILL.md frontmatter must include name and description.')).toBeVisible();
    await newSkillDialog.getByRole('textbox').fill(`---
name: missing-description
---

This file omits the required description frontmatter.
`);
    await newSkillDialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('SKILL.md frontmatter must include name and description.')).toBeVisible();
    expect(
      requests.filter((request) => request.method === 'POST' && request.path === '/v1/atoms/skills/upload')
    ).toHaveLength(0);
    await newSkillDialog.getByRole('textbox').fill(`---
name: api-rejected-skill
description: This content is valid locally but rejected by the API.
---

The backend rejects this skill packet.
`);
    await newSkillDialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Save failed.')).toBeVisible();
    await expect(newSkillDialog).toBeVisible();
    await newSkillDialog.getByRole('button', { name: 'Cancel' }).click();

    const codegraphSkillCard = page.locator('article').filter({ hasText: 'CodeGraph Navigator' });
    await codegraphSkillCard.hover();
    await codegraphSkillCard.getByRole('button', { name: 'Edit' }).click();
    const editDialog = page.getByRole('dialog', { name: 'Edit CodeGraph Navigator' });
    await editDialog.getByRole('textbox').fill(`---
name: renamed-skill
description: Existing skills cannot change names in place.
---

Try to rename an installed skill.
`);
    await editDialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Frontmatter name must stay codegraph-navigator.')).toBeVisible();
    expect(
      requests.filter(
        (request) => request.method === 'PUT' && request.path === '/v1/atoms/skills/codegraph-navigator/content'
      )
    ).toHaveLength(0);
    await editDialog.getByRole('textbox').fill(`---
name: codegraph-navigator
description: This keeps the existing skill name.
---

reject update
`);
    await editDialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Save failed.')).toBeVisible();
    await expect(editDialog).toBeVisible();
    await editDialog.getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('main').getByRole('button', { name: 'Install skill' }).first().click();
    await page.getByText('Upload .md or .zip').click();
    const uploadDialog = page.getByRole('dialog', { name: 'Upload skill' });
    await expect(uploadDialog).toBeVisible();
    const fileChooser = page.waitForEvent('filechooser');
    await uploadDialog.getByRole('button', { name: /Drag and drop or click to upload/ }).click();
    await (await fileChooser).setFiles({
      name: 'invalid-skill.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('not valid skill content')
    });
    await expect(page.getByText('Upload failed.')).toBeVisible();
    await expect(uploadDialog).toBeVisible();
    expect(
      requests.some(
        (request) =>
          request.method === 'POST' &&
          request.path === '/v1/atoms/skills/upload' &&
          request.search === '?filename=invalid-skill.md&overwrite=true'
      )
    ).toBe(true);
  });

  test('covers the empty installed state and its add action', async ({ page }) => {
    await installSkillsApiMock(page, { empty: true });
    await openSkills(page);

    await expect(page.getByText('No skills installed yet.')).toBeVisible();
    await page.getByRole('button', { name: 'Install skill' }).last().click();
    await expect(page.getByRole('dialog', { name: 'Import from GitHub' })).toBeVisible();
  });
});
