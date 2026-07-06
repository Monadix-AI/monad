import { expect, type Page, test } from '@playwright/test';

type Provider = {
  id: string;
  label: string;
  type: string;
  baseUrl?: string;
};

type Credential = {
  id: string;
  label: string;
  accessTokenPreview: string;
  requestCount: number;
  lastStatus?: 'ok' | 'error';
};

type Model = {
  id: string;
  label?: string;
  contextLimit?: number;
  detailUrl?: string;
  modelsDevUrl?: string;
  price?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    videoSecond?: number;
    units?: Array<{ label: string; price: number; unit: string }>;
  };
  releaseDate?: string;
  modalities?: {
    input?: string[];
    output?: string[];
    kind?: string;
    reasoning?: boolean;
    reasoningEfforts?: string[];
    defaultReasoningEffort?: string;
  };
};

type Profile = {
  alias: string;
  routes: Record<string, { provider: string; modelId: string } | undefined> & {
    chat: { provider: string; modelId: string };
  };
  params: Record<string, unknown>;
  routeParams?: Record<string, Record<string, unknown>>;
  fallbacks: unknown[];
};

type Agent = {
  id: string;
  name: string;
  model?: string;
  modelAlias?: string;
};

function json(body: unknown, status = 200) {
  return {
    body: JSON.stringify(body),
    contentType: 'application/json',
    status
  };
}

function providerOption(page: Page, name: string) {
  return page.getByRole('button', { name: new RegExp(`^${name} ${name}$`) });
}

function previewToken(token: string): string {
  return token.length <= 4 ? `...${token}` : `...${token.slice(-4)}`;
}

async function mockModelSettingsApi(
  page: Page,
  options: {
    agents?: Agent[];
    failNextProviderTest?: string;
    initialProfiles?: Profile[];
    onProviderModelsRequest?: (providerId: string) => void;
    onProfilesRequest?: () => void;
    providerModels?: Model[];
  } = {}
) {
  const providers: Provider[] = [{ id: 'oai', label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1' }];
  const credentials: Record<string, Credential[]> = {
    oai: [{ id: 'cred_main', label: 'main', accessTokenPreview: '...1234', requestCount: 7, lastStatus: 'ok' }]
  };
  const models: Record<string, Model[]> = {
    oai: options.providerModels ?? [
      {
        id: 'gpt-5.1',
        label: 'GPT 5.1',
        contextLimit: 200000,
        detailUrl: 'https://provider.example/models/gpt-5.1',
        modelsDevUrl: 'https://models.dev/models/openai/gpt-5-1',
        price: {
          input: 1,
          output: 2,
          cacheRead: 0.25,
          units: [
            { label: 'Input', price: 1, unit: 'M' },
            { label: 'Output', price: 2, unit: 'M' },
            { label: 'Cache read', price: 0.25, unit: 'M' },
            { label: 'Web Search', price: 0.01, unit: 'search' }
          ]
        },
        releaseDate: '2026-06-01',
        modalities: {
          input: ['text', 'image'],
          output: ['text'],
          reasoning: true,
          reasoningEfforts: ['max', 'xhigh', 'high'],
          defaultReasoningEffort: 'xhigh'
        }
      },
      {
        id: 'gpt-5.1-mini',
        label: 'GPT 5.1 Mini',
        contextLimit: 128000,
        modelsDevUrl: 'https://models.dev/models/openai/gpt-5-1-mini',
        releaseDate: '2026-05-01',
        modalities: { input: ['text'], output: ['text'], reasoning: true }
      },
      {
        id: 'text-embedding-3-large',
        label: 'Text Embedding 3 Large',
        price: {
          input: 0.13,
          units: [
            { label: 'Input', price: 0.13, unit: 'M' },
            { label: 'Song', price: 0.02, unit: 'song' }
          ]
        },
        modalities: { kind: 'embedding', output: ['embeddings'] }
      },
      {
        id: 'gpt-image-1',
        label: 'GPT Image 1',
        modalities: { kind: 'image', output: ['image'] }
      },
      {
        id: 'video-gen-1',
        label: 'Video Gen 1',
        contextLimit: 100000,
        price: { input: 0, output: 0, videoSecond: 0.08 },
        modalities: { kind: 'video', output: ['video'] }
      },
      {
        id: 'audio-1',
        label: 'Audio Analyzer 1',
        modalities: { kind: 'audio', output: ['audio'] }
      },
      {
        id: 'tts-1',
        label: 'Speech TTS 1',
        modalities: { kind: 'speech', output: ['speech'] }
      },
      {
        id: 'rerank-1',
        label: 'Rerank 1',
        price: {
          input: 0,
          output: 0,
          units: [
            { label: 'Input', price: 0, unit: 'M' },
            { label: 'Output', price: 0, unit: 'M' },
            { label: 'Search', price: 0.0025, unit: 'search' }
          ]
        },
        modalities: { kind: 'rerank', output: ['rerank'] }
      },
      {
        id: 'transcription-1',
        label: 'Transcription 1',
        price: {
          units: [{ label: 'Audio', price: 0.016, unit: 'minute' }]
        },
        modalities: { kind: 'transcription', output: ['transcription'] }
      },
      {
        id: 'qwen-asr-flash',
        label: 'Qwen ASR Flash',
        price: {
          units: [{ label: 'Video', price: 0.000035, unit: 'second' }]
        },
        modalities: { kind: 'transcription', output: ['transcription'] }
      }
    ]
  };
  const profiles: Profile[] = options.initialProfiles
    ? structuredClone(options.initialProfiles)
    : [
        {
          alias: 'default',
          routes: { chat: { provider: 'oai', modelId: 'gpt-5.1' } },
          params: { reasoningEffort: 'medium' },
          fallbacks: []
        }
      ];
  let defaultAlias = 'default';
  let providerCounter = 1;
  let credentialCounter = 1;
  let failNextProviderTest = options.failNextProviderTest;

  await page.route('**/api/health', (route) =>
    route.fulfill(json({ status: 'ok', version: '0.1.1', latestVersion: '0.1.1' }))
  );

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, '');
    const method = request.method();

    if (method === 'GET' && path === '/v1/init/status') {
      return route.fulfill(json({ initialized: true }));
    }
    if (method === 'GET' && path === '/v1/sessions') {
      return route.fulfill(json({ sessions: [], total: 0, hasMore: false }));
    }
    if (method === 'GET' && path === '/v1/commands') {
      return route.fulfill(json({ commands: [] }));
    }
    if (method === 'GET' && path === '/v1/workplace/projects') {
      return route.fulfill(json({ projects: [] }));
    }
    if (method === 'GET' && (path === '/v1/native-cli-runtimes' || path === '/v1/native-cli-session-summaries')) {
      return route.fulfill(json({ sessions: [] }));
    }
    if (method === 'GET' && path === '/v1/settings/locale') {
      return route.fulfill(json({ locale: 'en' }));
    }
    if (method === 'GET' && path === '/v1/i18n/catalog') {
      return route.fulfill(json({ locale: 'en', messages: {} }));
    }
    if (method === 'GET' && path === '/v1/agents') {
      return route.fulfill(json({ agents: options.agents ?? [] }));
    }
    if (method === 'GET' && path === '/v1/settings/model/providers/catalog') {
      return route.fulfill(
        json({
          providers: [
            { type: 'openai', label: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1' },
            { type: 'openai-compatible', label: 'OpenAI-compatible', needsUrl: true }
          ]
        })
      );
    }
    if (method === 'GET' && path === '/v1/settings/model/providers') {
      return route.fulfill(json({ providers }));
    }
    if (method === 'GET' && path === '/v1/settings/model/roles') {
      return route.fulfill(json({ roles: {} }));
    }
    if (method === 'PUT' && path.startsWith('/v1/settings/model/providers/')) {
      const body = request.postDataJSON() as { provider: Provider };
      const i = providers.findIndex((provider) => provider.id === body.provider.id);
      if (i === -1) providers.push(body.provider);
      else providers[i] = body.provider;
      credentials[body.provider.id] ??= [];
      models[body.provider.id] ??= [];
      return route.fulfill(json({ ok: true }));
    }
    if (method === 'DELETE' && path.startsWith('/v1/settings/model/providers/')) {
      const id = decodeURIComponent(path.split('/').at(-1) ?? '');
      const used = profiles.find((profile) => Object.values(profile.routes).some((route) => route?.provider === id));
      if (used) return route.fulfill(json({ error: `Used by profile ${used.alias}.` }, 409));
      providers.splice(
        providers.findIndex((provider) => provider.id === id),
        1
      );
      delete credentials[id];
      delete models[id];
      return route.fulfill(json({ ok: true }));
    }

    const providerCredentials = path.match(/^\/v1\/settings\/model\/providers\/([^/]+)\/credentials(?:\/([^/]+))?$/);
    if (providerCredentials) {
      const providerId = decodeURIComponent(providerCredentials[1] ?? '');
      const credentialId = providerCredentials[2] ? decodeURIComponent(providerCredentials[2]) : undefined;
      credentials[providerId] ??= [];
      if (method === 'GET' && !credentialId) return route.fulfill(json({ credentials: credentials[providerId] }));
      if (method === 'POST' && !credentialId) {
        const body = request.postDataJSON() as { label: string; accessToken: string };
        const credential = {
          id: `cred_${++credentialCounter}`,
          label: body.label,
          accessTokenPreview: previewToken(body.accessToken),
          requestCount: 0,
          lastStatus: 'ok' as const
        };
        credentials[providerId].push(credential);
        return route.fulfill(json({ id: credential.id }));
      }
      if (method === 'DELETE' && credentialId) {
        credentials[providerId] = credentials[providerId].filter((credential) => credential.id !== credentialId);
        return route.fulfill(json({ ok: true }));
      }
    }

    const credentialTest = path.match(/^\/v1\/settings\/model\/providers\/([^/]+)\/credentials\/([^/]+)\/test$/);
    if (method === 'POST' && credentialTest) {
      return route.fulfill(json({ ok: true, latencyMs: 42 }));
    }

    const providerModels = path.match(/^\/v1\/settings\/model\/providers\/([^/]+)\/models$/);
    if (method === 'GET' && providerModels) {
      const providerId = decodeURIComponent(providerModels[1] ?? '');
      options.onProviderModelsRequest?.(providerId);
      return route.fulfill(json({ models: models[providerId] ?? [] }));
    }
    if (method === 'POST' && (path === '/v1/settings/model/test' || path === '/v1/settings/model/test-connection')) {
      const body = request.postDataJSON() as { provider: Provider };
      const nextId = body.provider.id || `openai-compatible-${++providerCounter}`;
      if (failNextProviderTest) {
        const error = failNextProviderTest;
        failNextProviderTest = undefined;
        return route.fulfill(json({ ok: false, error }));
      }
      models[nextId] = [
        {
          id: 'llama-4-maverick',
          label: 'Llama 4 Maverick',
          modalities: { input: ['text', 'image'], output: ['text'], reasoning: true }
        },
        {
          id: 'embed-v1',
          label: 'Embed v1',
          modalities: { kind: 'embedding', output: ['embedding'] }
        },
        ...Array.from({ length: 7 }, (_, i) => ({
          id: `chat-extra-${i + 1}`,
          label: `Chat Extra ${i + 1}`,
          modalities: { input: ['text'], output: ['text'] }
        }))
      ];
      return route.fulfill(json({ ok: true, latencyMs: 31, models: models[nextId] }));
    }

    if (method === 'GET' && path === '/v1/settings/model/profiles') {
      options.onProfilesRequest?.();
      return route.fulfill(json({ profiles, defaultAlias }));
    }
    const profilePath = path.match(/^\/v1\/settings\/model\/profiles\/([^/]+)(?:\/alias)?$/);
    if (profilePath && method === 'PUT' && !path.endsWith('/alias')) {
      const body = request.postDataJSON() as { profile: Profile };
      const i = profiles.findIndex((profile) => profile.alias === body.profile.alias);
      if (i === -1) profiles.push(body.profile);
      else profiles[i] = body.profile;
      if (!defaultAlias) defaultAlias = body.profile.alias;
      return route.fulfill(json({ ok: true }));
    }
    if (profilePath && method === 'PATCH' && path.endsWith('/alias')) {
      const alias = decodeURIComponent(profilePath[1] ?? '');
      const body = request.postDataJSON() as { alias: string };
      const profile = profiles.find((item) => item.alias === alias);
      if (!profile) return route.fulfill(json({ error: 'not found' }, 404));
      profile.alias = body.alias;
      if (defaultAlias === alias) defaultAlias = body.alias;
      return route.fulfill(json({ ok: true }));
    }
    if (profilePath && method === 'DELETE') {
      const alias = decodeURIComponent(profilePath[1] ?? '');
      if (profiles.length <= 1 || alias === defaultAlias) {
        return route.fulfill(json({ error: 'Default profile cannot be deleted.' }, 409));
      }
      profiles.splice(
        profiles.findIndex((profile) => profile.alias === alias),
        1
      );
      return route.fulfill(json({ ok: true }));
    }
    if (method === 'PUT' && path === '/v1/settings/model/default') {
      const body = request.postDataJSON() as { alias: string };
      defaultAlias = body.alias;
      return route.fulfill(json({ ok: true }));
    }

    return route.fulfill(json({ error: `Unhandled ${method} ${path}` }, 404));
  });
}

async function openModels(page: Page) {
  await mockModelSettingsApi(page);
  await page.goto('/studio/models');
  await expect(page.getByRole('heading', { name: 'Models' })).toBeVisible({ timeout: 20_000 });
}

async function openModelsWithApi(page: Page, options: Parameters<typeof mockModelSettingsApi>[1]) {
  await mockModelSettingsApi(page, options);
  await page.goto('/studio/models');
  await expect(page.getByRole('heading', { name: 'Models' })).toBeVisible({ timeout: 20_000 });
}

async function addCompatibleProvider(page: Page, key = 'sk-added-9999') {
  await page.getByRole('button', { name: 'Provider', exact: true }).click();
  await page.getByRole('button', { name: 'OpenAI-compatible' }).click();
  await page.getByPlaceholder('https://…').fill('https://gateway.example/v1');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByPlaceholder('api key').fill(key);
  await page.getByRole('button', { name: 'Test' }).click();
  await expect(page.getByRole('button', { name: 'Add provider' })).toBeVisible();
  await page.getByRole('button', { name: 'Add provider' }).click();
}

test.describe('Studio model settings', () => {
  test('renders provider and profile state with protected delete affordances', async ({ page }) => {
    await openModels(page);

    await expect(page.getByRole('heading', { name: 'Providers' })).toBeVisible();
    await expect(page.locator('span').filter({ hasText: /^OpenAI$/ })).toBeVisible();
    await expect(page.getByText('1 key')).toBeVisible();
    await expect(page.getByText('10 models')).toBeVisible();
    await expect(page.getByText('default', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'default Default' })).toBeVisible();
    await expect(page.getByText('GPT 5.1', { exact: true })).toBeVisible();

    await expect(page.getByRole('button', { name: 'Delete provider' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Delete profile' })).toBeDisabled();
  });

  test('keeps the models page scrollable when content overflows', async ({ page }) => {
    await openModelsWithApi(page, {
      initialProfiles: Array.from({ length: 18 }, (_, index) => ({
        alias: index === 0 ? 'default' : `profile-${index}`,
        routes: { chat: { provider: 'oai', modelId: index % 2 === 0 ? 'gpt-5.1' : 'gpt-5.1-mini' } },
        params: {},
        fallbacks: []
      }))
    });

    const viewport = page
      .locator('[data-slot="scroll-area-viewport"]')
      .filter({ has: page.getByRole('heading', { name: 'Profiles' }) })
      .first();

    await expect(viewport).toBeVisible();
    await expect
      .poll(() =>
        viewport.evaluate((node) => ({
          clientHeight: node.clientHeight,
          scrollHeight: node.scrollHeight
        }))
      )
      .toMatchObject({ scrollHeight: expect.any(Number), clientHeight: expect.any(Number) });

    const canScroll = await viewport.evaluate((node) => node.scrollHeight > node.clientHeight);
    expect(canScroll).toBe(true);
    await viewport.evaluate((node) => {
      node.scrollTop = 400;
    });
    await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  });

  test('focuses the model id input when opening a model picker', async ({ page }) => {
    await openModels(page);

    const defaultCard = page.locator('.rounded-lg').filter({ hasText: 'default' }).first();
    await defaultCard.getByRole('button', { name: 'OpenAI GPT 5.1' }).click();

    const input = page.getByPlaceholder('model-id');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
  });

  test('renders reasoning effort controls from model metadata only', async ({ page }) => {
    await openModels(page);

    const defaultCard = page.locator('.rounded-lg').filter({ hasText: 'default' }).first();
    await expect(defaultCard.getByRole('button', { name: 'Effort Xhigh' })).toBeVisible();
    await defaultCard.getByRole('button', { name: 'Effort Xhigh' }).click();
    await expect(page.locator('[data-slot="popover-content"]').getByRole('button', { name: 'Max' })).toBeVisible();
    await expect(page.locator('[data-slot="popover-content"]').getByRole('button', { name: 'Xhigh' })).toBeVisible();
    await page.locator('[data-slot="popover-content"]').getByRole('button', { name: 'High', exact: true }).click();
    await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);
    await expect(defaultCard.getByRole('button', { name: 'Effort High' })).toBeVisible();
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(defaultCard.getByRole('button', { name: 'Effort High' })).toBeVisible();
    await expect(defaultCard.getByRole('button', { name: 'Minimal' })).toHaveCount(0);
    await expect(defaultCard.getByRole('button', { name: 'Low' })).toHaveCount(0);
    await expect(defaultCard.getByRole('button', { name: 'Medium' })).toHaveCount(0);

    await defaultCard.getByRole('button', { name: 'OpenAI GPT 5.1' }).hover();
    const hoverCard = page.locator('[data-slot="hover-card-content"]');
    await expect(hoverCard.getByText('Yes')).toBeVisible();
    await expect(hoverCard.getByRole('link', { name: 'See detail' })).toHaveAttribute(
      'href',
      'https://provider.example/models/gpt-5.1'
    );
    await hoverCard.getByText('Yes').hover();
    await expect(page.getByText('Reasoning: max, xhigh, high')).toBeVisible();
  });

  test('does not render reasoning controls when a reasoning model has no effort metadata', async ({ page }) => {
    await openModelsWithApi(page, {
      initialProfiles: [
        {
          alias: 'default',
          routes: { chat: { provider: 'oai', modelId: 'gpt-5.1-mini' } },
          params: {},
          fallbacks: []
        }
      ]
    });

    const defaultCard = page.locator('.rounded-lg').filter({ hasText: 'default' }).first();
    await expect(defaultCard.getByText('Effort')).toHaveCount(0);
    await expect(defaultCard.getByRole('button', { name: 'Max', exact: true })).toHaveCount(0);
    await defaultCard.getByRole('button', { name: 'OpenAI GPT 5.1 Mini' }).hover();
    const hoverCard = page.locator('[data-slot="hover-card-content"]');
    await expect(hoverCard.getByText('No')).toBeVisible();
    await expect(hoverCard.getByRole('link', { name: 'See detail' })).toHaveAttribute(
      'href',
      'https://models.dev/models/openai/gpt-5-1-mini'
    );
  });

  test('shows every provider output modality in the provider model list', async ({ page }) => {
    await openModels(page);

    await page.getByRole('button', { name: 'Edit provider' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('tab', { name: 'All 10' })).toBeVisible();
    await expect(dialog.getByRole('tab', { name: 'Text 2' })).toBeVisible();
    await expect(dialog.getByRole('tab', { name: 'Video 1' })).toBeVisible();
    await expect(dialog.getByRole('tab', { name: 'Transcription 2' })).toBeVisible();

    for (const label of [
      'Output: Text',
      'Output: Image',
      'Output: Embeddings',
      'Output: Audio',
      'Output: Video',
      'Output: Rerank',
      'Output: Speech',
      'Output: Transcription'
    ]) {
      await expect(dialog.getByLabel(label).first()).toBeVisible();
    }

    await dialog.getByRole('tab', { name: 'Video 1' }).click();
    await expect(dialog.getByText('Video Gen 1')).toBeVisible();
    await expect(dialog.getByText('GPT 5.1', { exact: true })).toBeHidden();
    await dialog.getByRole('tab', { name: 'All 10' }).click();
    await expect(dialog.getByText('GPT 5.1', { exact: true })).toBeVisible();
    await expect(dialog.getByText('$0.0025/search')).toBeVisible();
  });

  test('shows media and embedding pricing without reasoning-only fields', async ({ page }) => {
    await openModelsWithApi(page, {
      initialProfiles: [
        {
          alias: 'default',
          routes: {
            chat: { provider: 'oai', modelId: 'gpt-5.1' },
            embedding: { provider: 'oai', modelId: 'text-embedding-3-large' },
            speech: { provider: 'oai', modelId: 'tts-1' },
            transcription: { provider: 'oai', modelId: 'transcription-1' },
            video: { provider: 'oai', modelId: 'video-gen-1' }
          },
          params: {},
          fallbacks: []
        }
      ]
    });

    const defaultCard = page.locator('.rounded-lg').filter({ hasText: 'default' }).first();
    await expect(defaultCard.locator('[data-role-row="video"]').getByText('Inherited')).toHaveCount(0);
    await expect(defaultCard.locator('[data-role-row="speech"]').getByText('Inherited')).toHaveCount(0);
    await expect(defaultCard.locator('[data-role-row="transcription"]').getByText('Inherited')).toHaveCount(0);
    await expect(defaultCard.locator('[data-role-row="embedding"]').getByText('Inherited')).toHaveCount(0);

    await defaultCard.getByRole('button', { name: 'OpenAI GPT 5.1' }).hover();
    let hoverCard = page.locator('[data-slot="hover-card-content"]');
    await expect(hoverCard.getByText('$1/M · $2/M')).toBeVisible();
    await expect(hoverCard.getByText('$0.25/M')).toHaveCount(0);
    await expect(hoverCard.getByText('$0.01/search')).toHaveCount(0);
    await hoverCard.getByText('$1/M · $2/M').hover();
    await expect(page.getByRole('tooltip').getByText('Cache read $0.25/M')).toBeVisible();
    await expect(page.getByRole('tooltip').getByText('Web Search $0.01/search')).toBeVisible();

    await defaultCard.getByRole('button', { name: 'OpenAI Video Gen 1' }).hover();
    hoverCard = page.locator('[data-slot="hover-card-content"]');
    await expect(hoverCard.getByText('$0.08/seconds')).toBeVisible();
    await expect(hoverCard.getByText('100K')).toHaveCount(0);
    await expect(hoverCard.getByText('$1.25')).toHaveCount(0);
    await expect(hoverCard.getByText('$5')).toHaveCount(0);

    await defaultCard.getByRole('button', { name: 'OpenAI Text Embedding 3 Large' }).hover();
    hoverCard = page.locator('[data-slot="hover-card-content"]');
    await expect(hoverCard.getByText('Yes')).toHaveCount(0);
    await expect(hoverCard.getByText('No')).toHaveCount(0);
    await expect(hoverCard.getByText('$0.13/M')).toBeVisible();
    await hoverCard.getByText('$0.13/M').hover();
    await expect(page.getByRole('tooltip').getByText('Song $0.02/song')).toBeVisible();

    await page.getByRole('button', { name: 'Edit provider' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('$0.016/minute')).toBeVisible();
    await expect(dialog.getByText('$0.000035/seconds')).toBeVisible();
  });

  test('refresh button refetches model settings data', async ({ page }) => {
    let profilesRequests = 0;
    await openModelsWithApi(page, { onProfilesRequest: () => profilesRequests++ });
    await expect.poll(() => profilesRequests).toBeGreaterThan(0);

    const beforeRefresh = profilesRequests;
    await page.getByRole('button', { name: 'Refresh' }).first().click();
    await expect.poll(() => profilesRequests).toBeGreaterThan(beforeRefresh);
  });

  test('adds a provider after base URL and key validation, then manages keys and model filtering', async ({ page }) => {
    await openModels(page);

    await page.getByRole('button', { name: 'Provider', exact: true }).click();
    await page.getByRole('button', { name: 'OpenAI-compatible' }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Enter a URL.')).toBeVisible();
    await page.getByPlaceholder('https://…').fill('ftp://bad');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Enter a valid URL that starts with http:// or https://.')).toBeVisible();
    await page.getByPlaceholder('https://…').fill('https://gateway.example/v1');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByPlaceholder('api key').fill('sk-added-9999');
    await page.getByRole('button', { name: 'Test' }).click();
    await expect(page.getByRole('button', { name: 'Add provider' })).toBeVisible();
    await expect(page.getByText('Llama 4 Maverick')).toBeVisible();
    await page.getByRole('button', { name: 'Add provider' }).click();

    await expect(page.getByText('OpenAI-compatible', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Edit provider' }).nth(1).click();
    await expect(page.getByText('...9999')).toBeVisible();
    await page.getByRole('button', { name: 'Key', exact: true }).click();
    await page.getByPlaceholder('label').fill('backup');
    await page.getByPlaceholder('api key').fill('sk-backup-4242');
    await page.getByRole('button', { name: 'Test' }).first().click();
    await expect(page.getByText('backup')).toBeVisible();
    await expect(page.getByText('...4242')).toBeVisible();

    await page.getByPlaceholder('filter models...').fill('embed');
    await expect(page.getByText('Embed v1')).toBeVisible();
    await expect(page.getByText('Llama 4 Maverick')).toBeHidden();
    await page.getByPlaceholder('filter models...').fill('not-a-real-model');
    await expect(page.getByText('No models')).toBeVisible();
  });

  test('keeps provider add dialog state safe across back, cancel, failed test, and retry', async ({ page }) => {
    await openModelsWithApi(page, { failNextProviderTest: 'gateway timeout' });

    await page.getByRole('button', { name: 'Provider', exact: true }).click();
    await page.getByRole('button', { name: 'OpenAI-compatible' }).click();
    await page.getByPlaceholder('https://…').fill('https://gateway.example/v1');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByPlaceholder('api key')).toBeVisible();
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByPlaceholder('https://…')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    await page.getByRole('button', { name: 'Provider', exact: true }).click();
    await page.getByRole('button', { name: 'OpenAI-compatible' }).click();
    await page.getByPlaceholder('https://…').fill('https://gateway.example/v1');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Test' }).click();
    await expect(page.getByText('Enter an API key.')).toBeVisible();

    await page.getByPlaceholder('api key').fill('sk-retry-7777');
    await page.getByRole('button', { name: 'Test' }).click();
    await expect(page.getByText('✗ gateway timeout')).toBeVisible();
    await page.getByRole('button', { name: 'Test' }).click();
    await expect(page.getByText('Llama 4 Maverick')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add provider' })).toBeVisible();
  });

  test('adds the built-in OpenAI provider path without a base URL step', async ({ page }) => {
    await openModels(page);

    await page.getByRole('button', { name: 'Provider', exact: true }).click();
    await providerOption(page, 'OpenAI').click();
    await expect(page.getByPlaceholder('https://…')).toBeHidden();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByPlaceholder('api key')).toBeVisible();
    await page.getByPlaceholder('api key').fill('sk-openai-5555');
    await page.getByRole('button', { name: 'Test' }).click();
    await expect(page.getByText('Llama 4 Maverick')).toBeVisible();
    await page.getByRole('button', { name: 'Add provider' }).click();

    await page.getByRole('button', { name: 'Edit provider' }).nth(1).click();
    await expect(page.getByText('...5555')).toBeVisible();
  });

  test('tests and deletes existing provider credentials without removing provider configuration', async ({ page }) => {
    await openModels(page);

    await page.getByRole('button', { name: 'Edit provider' }).first().click();
    await page.getByRole('button', { name: 'Test' }).first().click();
    await expect(page.getByText('ok 42ms')).toBeVisible();

    await page.getByRole('button', { name: 'Delete key' }).click();
    await expect(page.getByText('No keys.')).toBeVisible();
    await page.getByRole('button', { name: 'Key', exact: true }).click();
    await page.getByRole('button', { name: 'Test' }).first().click();
    await expect(page.getByText('Enter both a label and key.')).toBeVisible();
  });

  test('refreshes provider model metadata without clearing configured models', async ({ page }) => {
    let modelRequests = 0;
    await openModelsWithApi(page, {
      onProviderModelsRequest: (providerId) => {
        if (providerId === 'oai') modelRequests++;
      }
    });

    await page.getByRole('button', { name: 'Edit provider' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('GPT 5.1', { exact: true }).first()).toBeVisible();
    const beforeRefresh = modelRequests;
    await dialog.getByRole('button', { name: 'Refresh' }).click();
    await expect.poll(() => modelRequests).toBeGreaterThan(beforeRefresh);
    await expect(dialog.getByText('GPT 5.1', { exact: true }).first()).toBeVisible();
  });

  test('shows every provider model in the provider model list', async ({ page }) => {
    const providerModels = Array.from({ length: 55 }, (_, index) => ({
      id: `bulk-model-${String(index + 1).padStart(2, '0')}`,
      label: `Bulk Model ${String(index + 1).padStart(2, '0')}`,
      modalities: { input: ['text'], output: ['text'] }
    }));
    await openModelsWithApi(page, { providerModels });

    await page.getByRole('button', { name: 'Edit provider' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('(55)')).toBeVisible();
    await expect(dialog.getByText('Bulk Model 01')).toBeVisible();
    await dialog.getByText('Bulk Model 55').scrollIntoViewIfNeeded();
    await expect(dialog.getByText('Bulk Model 55')).toBeVisible();
  });

  test('deletes an unused provider but keeps profile-backed providers protected', async ({ page }) => {
    await openModels(page);
    await addCompatibleProvider(page);

    const openAiCard = page.locator('.rounded-lg').filter({ hasText: 'https://api.openai.com/v1' }).first();
    await expect(openAiCard.getByRole('button', { name: 'Delete provider' })).toBeDisabled();

    const compatibleCard = page.locator('.rounded-lg').filter({ hasText: 'https://gateway.example/v1' }).first();
    await expect(compatibleCard.getByRole('button', { name: 'Delete provider' })).toBeEnabled();
    await compatibleCard.getByRole('button', { name: 'Delete provider' }).click();
    await expect(page.getByText('https://gateway.example/v1')).toBeHidden();
  });

  test('blocks deleting a non-default profile that is still referenced by an agent', async ({ page }) => {
    await openModelsWithApi(page, {
      agents: [{ id: 'agent_1', name: 'Research Agent', modelAlias: 'research' }],
      initialProfiles: [
        {
          alias: 'default',
          routes: { chat: { provider: 'oai', modelId: 'gpt-5.1' } },
          params: { reasoningEffort: 'medium' },
          fallbacks: []
        },
        {
          alias: 'research',
          routes: { chat: { provider: 'oai', modelId: 'gpt-5.1-mini' } },
          params: { reasoningEffort: 'low' },
          fallbacks: []
        }
      ]
    });

    const researchCard = page.locator('.rounded-lg').filter({ hasText: 'research' }).first();
    await researchCard.hover();
    await expect(researchCard.getByRole('button', { name: 'Set as default' })).toBeVisible();
    const deleteProfile = researchCard.getByRole('button', { name: 'Delete profile' });
    await expect(deleteProfile).toBeDisabled();
    await deleteProfile.locator('xpath=..').hover();
    await expect(page.getByText('Used by agent Research Agent.')).toBeVisible();
  });

  test('handles draft profile cancel, disabled save, custom model ids, and role clearing', async ({ page }) => {
    await openModels(page);

    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    const draftCard = page
      .locator('.rounded-lg')
      .filter({ has: page.getByRole('textbox') })
      .first();
    await draftCard.hover();
    await page.getByRole('button', { name: 'Save' }).click({ force: true });
    const untitledCard = page.locator('.rounded-lg').filter({ hasText: 'Untitled' }).first();
    await expect(untitledCard).toBeVisible();
    await untitledCard.hover();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(untitledCard).toBeHidden();

    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    await page.getByRole('textbox').first().fill('custom');
    await page.getByRole('button', { name: 'Select model' }).click();
    await providerOption(page, 'OpenAI').click();
    await page.getByPlaceholder('model-id').fill('custom-chat-model');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'OpenAI custom-chat-model' })).toBeVisible();
    await page.locator('.rounded-lg').filter({ hasText: 'custom' }).first().hover();
    await page.getByRole('button', { name: 'Save' }).click();

    const customCard = page.locator('.rounded-lg').filter({ hasText: 'custom' }).first();
    await expect(customCard.getByText('custom-chat-model')).toBeVisible();

    await customCard.getByRole('button', { name: 'Use default model' }).first().click();
    await providerOption(page, 'OpenAI').click();
    await page.getByRole('button', { name: 'GPT 5.1 Mini gpt-5.1-mini' }).click();
    await expect(customCard.getByText('GPT 5.1 Mini')).toBeVisible();

    await customCard.getByRole('button', { name: /GPT 5\.1 Mini/ }).click();
    await page.locator('[data-slot="popover-content"]').getByRole('button', { name: 'Use default model' }).click();
    await expect(customCard.getByRole('button', { name: 'Use default model' }).first()).toBeVisible();
  });

  test('creates, edits, promotes, and deletes profiles through model pickers', async ({ page }) => {
    await openModels(page);

    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    await page.getByRole('textbox').first().fill('research');
    await page.getByRole('button', { name: 'Select model' }).click();
    await providerOption(page, 'OpenAI').click();
    await page.getByRole('button', { name: 'GPT 5.1 Mini gpt-5.1-mini' }).click();
    await page.locator('.rounded-lg').filter({ hasText: 'research' }).first().hover();
    await page.getByRole('button', { name: 'Save' }).click();

    const researchCard = page.locator('.rounded-lg').filter({ hasText: 'research' }).first();
    await expect(researchCard.getByText('GPT 5.1 Mini')).toBeVisible();

    await researchCard.hover();
    await researchCard.getByRole('button', { name: 'Set as default' }).click();
    await expect(researchCard.getByRole('button', { name: 'research Default' })).toBeVisible();

    await researchCard.getByText('research').click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.type('analysis');
    await page.keyboard.press('Enter');
    await expect(page.getByText('analysis')).toBeVisible();
    const analysisCard = page.locator('.rounded-lg').filter({ hasText: 'analysis' }).first();

    await analysisCard.getByRole('button', { name: 'Use default model' }).first().click();
    await providerOption(page, 'OpenAI').click();
    await page.getByRole('button', { name: 'GPT 5.1 gpt-5.1' }).click();
    await expect(analysisCard.getByText('GPT 5.1', { exact: true })).toBeVisible();

    await analysisCard.getByRole('button', { name: 'Not set' }).first().click();
    await providerOption(page, 'OpenAI').click();
    await page.getByRole('button', { name: 'Text Embedding 3 Large text-embedding-3-large' }).click();
    await expect(analysisCard.getByText('Text Embedding 3 Large')).toBeVisible();

    await expect(analysisCard.getByRole('button', { name: 'Effort Xhigh' }).first()).toBeVisible();

    const defaultCard = page.locator('.rounded-lg').filter({ hasText: 'default' }).first();
    await defaultCard.hover();
    await defaultCard.getByRole('button', { name: 'Set as default' }).click();
    await analysisCard.hover();
    await expect(analysisCard.getByRole('button', { name: 'Delete profile' })).toBeEnabled();
    await analysisCard.getByRole('button', { name: 'Delete profile' }).click();
    await expect(page.getByText('analysis')).toBeHidden();
  });
});
