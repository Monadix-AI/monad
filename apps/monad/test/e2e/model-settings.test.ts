// e2e: the model-settings REST surface over a real temp ~/.monad. Exercises the
// provider/credential/profile/default CRUD and asserts secrets are redacted in
// responses while the full token is persisted to auth.json. Runs over both transports.

import type { MonadPaths } from '@monad/home';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome, loadAuth, loadConfig } from '@monad/home';
import { ModelProviderType } from '@monad/protocol';

import { ModelService } from '@/handlers/settings/model/index.ts';
import { ModelCatalogService } from '@/services/model-catalog.ts';
import { createHttpTransport } from '@/transports/http.ts';
import {
  buildHandlers,
  makeTestPaths,
  mockModel,
  seededProviderRegistry,
  serveTransport,
  TRANSPORTS,
  type TransportHandle
} from '../helpers.ts';

function makePaths(base: string): MonadPaths {
  return makeTestPaths(base);
}

function profile(alias: string, modelId: string) {
  return {
    alias,
    routes: { chat: { provider: 'oai', modelId } },
    params: {},
    fallbacks: []
  };
}

type ProviderModelCacheFile = {
  providers: Record<string, { models: Array<{ id: string }> }>;
};

function providerModelCachePath(paths: MonadPaths): string {
  return join(paths.cache, 'provider-models.json');
}

async function readProviderModelCache(paths: MonadPaths): Promise<ProviderModelCacheFile> {
  return (await Bun.file(providerModelCachePath(paths)).json()) as ProviderModelCacheFile;
}

for (const kind of TRANSPORTS) {
  describe(`model-settings over ${kind}`, () => {
    let dir: string;
    let paths: MonadPaths;
    let t: TransportHandle;

    beforeEach(async () => {
      dir = join(tmpdir(), `monad-modelsettings-${Date.now()}-${process.hrtime.bigint()}`);
      paths = makePaths(dir);
      await initMonadHome(paths);

      const cfg = await loadConfig(paths.config);
      if (!cfg) throw new Error('config missing after init');
      const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry());
      t = serveTransport(kind, createHttpTransport(buildHandlers(mockModel(), { paths, modelService })));
    });

    afterEach(async () => {
      await t.stop();
      await rm(dir, { recursive: true, force: true });
    });

    const json = (method: string, path: string, body?: unknown) =>
      t.fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });

    test('rejects invalid provider baseUrl at the HTTP schema boundary', async () => {
      const res = await json('PUT', '/v1/settings/model/providers/bad-url', {
        provider: { id: 'bad-url', label: 'Bad URL', type: 'openai-compatible', baseUrl: 'ftp://api.test/v1' }
      });

      expect(res.status).toBe(400);
      const cfg = await loadConfig(paths.config);
      expect(cfg?.model.providers.some((provider) => provider.id === 'bad-url')).toBe(false);
    });

    test('provider + credential + profile + default CRUD round-trips and redacts secrets', async () => {
      // 1. add an provider
      await json('PUT', '/v1/settings/model/providers/oai', {
        provider: { id: 'oai', label: 'OpenAI-compatible', type: 'openai-compatible', baseUrl: 'https://api.test/v1' }
      });
      const providers = (await (await json('GET', '/v1/settings/model/providers')).json()) as {
        providers: { id: string }[];
      };
      expect(providers.providers.map((u) => u.id)).toContain('oai');

      // 2. add a credential — response carries only the new id
      const added = (await (
        await json('POST', '/v1/settings/model/providers/oai/credentials', {
          label: 'primary',
          authType: 'api_key',
          accessToken: 'sk-supersecret-1234'
        })
      ).json()) as { id: string };
      expect(added.id).toMatch(/^cred_/);

      // 3. list is redacted: a masked preview, never the raw token
      const credsRes = (await (await json('GET', '/v1/settings/model/providers/oai/credentials')).json()) as {
        credentials: Array<Record<string, unknown>>;
      };
      expect(credsRes.credentials).toHaveLength(1);
      const view = credsRes.credentials[0] ?? {};
      expect(view.accessTokenPreview).toBe('...1234');
      expect(view).not.toHaveProperty('accessToken');

      // ...but auth.json on disk holds the full secret (chmod 600).
      const auth = await loadAuth(paths.auth);
      expect(auth?.credentialPool.oai?.[0]?.accessToken).toBe('sk-supersecret-1234');

      // 4. add a profile + set default; both persist to config.json
      await json('PUT', '/v1/settings/model/profiles/default', {
        profile: { ...profile('default', 'gpt-x'), params: { temperature: 0.5 } }
      });
      await json('PUT', '/v1/settings/model/default', { alias: 'default' });
      const profiles = (await (await json('GET', '/v1/settings/model/profiles')).json()) as {
        defaultAlias: string;
        profiles: Array<Record<string, unknown>>;
      };
      expect(profiles.defaultAlias).toBe('default');
      expect(profiles.profiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            alias: 'default',
            routes: { chat: { provider: 'oai', modelId: 'gpt-x' } }
          })
        ])
      );

      const cfg = await loadConfig(paths.config);
      expect(cfg?.model.profiles.find((profile) => profile.alias === 'default')?.routes.chat.modelId).toBe('gpt-x');
      expect(cfg?.model.providers).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'oai' })]));

      // 5. delete the credential
      await json('DELETE', `/v1/settings/model/providers/oai/credentials/${added.id}`);
      const after = (await (await json('GET', '/v1/settings/model/providers/oai/credentials')).json()) as {
        credentials: unknown[];
      };
      expect(after.credentials).toHaveLength(0);
    });

    test('rejects an unknown default profile', async () => {
      const res = await json('PUT', '/v1/settings/model/default', { alias: 'ghost' });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    test('any existing profile can be set as default', async () => {
      await json('PUT', '/v1/settings/model/providers/oai', {
        provider: { id: 'oai', label: 'OpenAI-compatible', type: 'openai-compatible', baseUrl: 'https://api.test/v1' }
      });
      await json('PUT', '/v1/settings/model/profiles/default', {
        profile: profile('default', 'gpt-x')
      });
      await json('PUT', '/v1/settings/model/profiles/fast', {
        profile: profile('fast', 'gpt-fast')
      });

      const res = await json('PUT', '/v1/settings/model/default', { alias: 'fast' });
      expect(res.status).toBe(200);

      const profiles = (await (await json('GET', '/v1/settings/model/profiles')).json()) as { defaultAlias: string };
      expect(profiles.defaultAlias).toBe('fast');
      expect((await loadConfig(paths.config))?.model.default).toBe('fast');
    });

    test('rejects deleting the protected default profile', async () => {
      await json('PUT', '/v1/settings/model/providers/oai', {
        provider: { id: 'oai', label: 'OpenAI-compatible', type: 'openai-compatible', baseUrl: 'https://api.test/v1' }
      });
      await json('PUT', '/v1/settings/model/profiles/default', {
        profile: profile('default', 'gpt-x')
      });

      const res = await json('DELETE', '/v1/settings/model/profiles/default');
      expect(res.status).toBe(409);

      const cfg = await loadConfig(paths.config);
      expect(cfg?.model.profiles.some((profile) => profile.alias === 'default')).toBe(true);
    });

    test('rejects deleting whichever profile is currently set as default', async () => {
      await json('PUT', '/v1/settings/model/providers/oai', {
        provider: { id: 'oai', label: 'OpenAI-compatible', type: 'openai-compatible', baseUrl: 'https://api.test/v1' }
      });
      await json('PUT', '/v1/settings/model/profiles/default', {
        profile: profile('default', 'gpt-x')
      });
      await json('PUT', '/v1/settings/model/profiles/fast', {
        profile: profile('fast', 'gpt-fast')
      });
      await json('PUT', '/v1/settings/model/default', { alias: 'fast' });

      const res = await json('DELETE', '/v1/settings/model/profiles/fast');
      expect(res.status).toBe(409);

      const cfg = await loadConfig(paths.config);
      expect(cfg?.model.profiles.some((profile) => profile.alias === 'fast')).toBe(true);
    });

    test('rejects deleting a provider while any profile uses it', async () => {
      await json('PUT', '/v1/settings/model/providers/oai', {
        provider: { id: 'oai', label: 'OpenAI-compatible', type: 'openai-compatible', baseUrl: 'https://api.test/v1' }
      });
      await json('PUT', '/v1/settings/model/profiles/default', {
        profile: profile('default', 'gpt-x')
      });

      const res = await json('DELETE', '/v1/settings/model/providers/oai');
      expect(res.status).toBeGreaterThanOrEqual(400);

      const cfg = await loadConfig(paths.config);
      expect(cfg?.model.providers.some((provider) => provider.id === 'oai')).toBe(true);
    });

    test('deleting an unused provider also removes its credentials', async () => {
      await json('PUT', '/v1/settings/model/providers/oai', {
        provider: { id: 'oai', label: 'OpenAI-compatible', type: 'openai-compatible', baseUrl: 'https://api.test/v1' }
      });
      await json('POST', '/v1/settings/model/providers/oai/credentials', {
        label: 'primary',
        authType: 'api_key',
        accessToken: 'sk-supersecret-1234'
      });
      await Bun.write(
        providerModelCachePath(paths),
        JSON.stringify({
          providers: {
            oai: {
              providerType: ModelProviderType.OpenAICompatible,
              baseUrl: 'https://api.test/v1',
              credentialId: 'cached-cred',
              updatedAt: new Date().toISOString(),
              models: [{ id: 'cached-model' }]
            }
          }
        })
      );

      const res = await json('DELETE', '/v1/settings/model/providers/oai');
      expect(res.status).toBe(200);

      const cfg = await loadConfig(paths.config);
      const auth = await loadAuth(paths.auth);
      const cache = await readProviderModelCache(paths);
      expect(cfg?.model.providers.some((provider) => provider.id === 'oai')).toBe(false);
      expect(auth?.credentialPool.oai).toBeUndefined();
      expect(cache.providers.oai).toBeUndefined();
    });

    test('list models returns cached models immediately while refreshing in the background', async () => {
      const cfg = await loadConfig(paths.config);
      if (!cfg) throw new Error('config missing');
      const registry = seededProviderRegistry();
      const openai = registry.get(ModelProviderType.OpenAICompatible);
      if (!openai) throw new Error('openai-compatible provider missing');

      let calls = 0;
      let releaseRefresh: (() => void) | undefined;
      registry.register({
        ...openai,
        listModels: async () => {
          calls += 1;
          if (calls === 1) return [{ id: 'remote-first', label: 'Remote first' }];
          await new Promise<void>((resolve) => {
            releaseRefresh = resolve;
          });
          return [{ id: 'remote-fresh', label: 'Remote fresh' }];
        }
      });
      const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), registry);

      await t.stop();
      t = serveTransport(kind, createHttpTransport(buildHandlers(mockModel(), { paths, modelService })));

      await json('PUT', '/v1/settings/model/providers/oai', {
        provider: { id: 'oai', label: 'OpenAI-compatible', type: 'openai-compatible', baseUrl: 'https://api.test/v1' }
      });
      await json('POST', '/v1/settings/model/providers/oai/credentials', {
        label: 'primary',
        authType: 'api_key',
        accessToken: 'sk-supersecret-1234'
      });

      const firstRes = await json('GET', '/v1/settings/model/providers/oai/models');
      expect(firstRes.status).toBe(200);
      const first = (await firstRes.json()) as {
        models: Array<{ id: string }>;
      };
      expect(first.models.map((model) => model.id)).toEqual(['remote-first']);

      const secondRes = await json('GET', '/v1/settings/model/providers/oai/models');
      expect(secondRes.status).toBe(200);
      const second = (await secondRes.json()) as {
        models: Array<{ id: string }>;
      };
      expect(second.models.map((model) => model.id)).toEqual(['remote-first']);
      expect(calls).toBe(2);

      releaseRefresh?.();
      for (let i = 0; i < 20; i += 1) {
        const cached = (await readProviderModelCache(paths)).providers.oai?.models.map((model) => model.id);
        if (cached?.[0] === 'remote-fresh') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect((await readProviderModelCache(paths)).providers.oai?.models.map((model) => model.id)).toEqual([
        'remote-fresh'
      ]);

      const persistedConfig = await loadConfig(paths.config);
      expect(persistedConfig).not.toHaveProperty('model.modelCache');
    });

    test('test connection enriches provider models with catalog fallback', async () => {
      const cfg = await loadConfig(paths.config);
      if (!cfg) throw new Error('config missing');
      const registry = seededProviderRegistry();
      const deepseek = registry.get(ModelProviderType.DeepSeek);
      if (!deepseek) throw new Error('deepseek provider missing');
      registry.register({
        ...deepseek,
        listModels: async () => [{ id: 'deepseek-v4-flash' }]
      });
      const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), registry);
      const catalog = new ModelCatalogService({
        cachePath: join(dir, 'model-catalog.json'),
        log: () => {},
        url: 'https://catalog.test/api.json',
        modelsUrl: 'https://catalog.test/models.json',
        fetchImpl: (async (url: string) =>
          new Response(
            JSON.stringify(
              url.includes('models.json')
                ? {
                    'deepseek/deepseek-v4-flash': {
                      id: 'deepseek/deepseek-v4-flash',
                      name: 'DeepSeek V4 Flash',
                      modalities: { input: ['text'], output: ['text'] }
                    }
                  }
                : {
                    deepseek: {
                      models: {
                        'deepseek-v4-flash': {
                          id: 'deepseek/deepseek-v4-flash',
                          name: 'DeepSeek V4 Flash',
                          modalities: { input: ['text'], output: ['text'] },
                          limit: { context: 1000000 },
                          cost: { input: 0.14, output: 0.28, cache_read: 0.0028 },
                          release_date: '2026-02-01'
                        }
                      }
                    }
                  }
            ),
            { status: 200 }
          )) as unknown as typeof fetch
      });
      await catalog.refresh();

      await t.stop();
      t = serveTransport(
        kind,
        createHttpTransport(buildHandlers(mockModel(), { paths, modelService, modelCatalog: catalog }))
      );

      const res = await json('POST', '/v1/settings/model/test-connection', {
        provider: { id: 'deepseek', label: 'DeepSeek', type: ModelProviderType.DeepSeek },
        accessToken: 'sk-test'
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        models?: Array<Record<string, unknown>>;
      };
      expect(body.ok).toBe(true);
      expect(body.models?.[0]).toMatchObject({
        id: 'deepseek-v4-flash',
        label: 'DeepSeek V4 Flash',
        contextLimit: 1000000,
        releaseDate: '2026-02-01',
        price: { input: 0.14, output: 0.28, cacheRead: 0.0028 },
        modalities: { input: ['text'], output: ['text'], kind: 'chat' },
        detailUrl: 'https://models.dev/models/deepseek/deepseek-v4-flash',
        modelsDevUrl: 'https://models.dev/models/deepseek/deepseek-v4-flash'
      });
    });

    test('rejects deleting a profile while any agent uses it', async () => {
      await json('PUT', '/v1/settings/model/providers/oai', {
        provider: { id: 'oai', label: 'OpenAI-compatible', type: 'openai-compatible', baseUrl: 'https://api.test/v1' }
      });
      await json('PUT', '/v1/settings/model/profiles/default', {
        profile: profile('default', 'gpt-x')
      });
      await json('PUT', '/v1/settings/model/profiles/research', {
        profile: profile('research', 'gpt-research')
      });
      await json('PUT', '/v1/settings/model/profiles/writer', {
        profile: profile('writer', 'gpt-writer')
      });
      await json('POST', '/v1/agents', { name: 'Researcher', modelAlias: 'research', capabilities: [] });

      const res = await json('DELETE', '/v1/settings/model/profiles/research');
      expect(res.status).toBeGreaterThanOrEqual(400);

      await json('POST', '/v1/agents', { name: 'Writer', model: 'writer', capabilities: [] });
      const modelFieldRes = await json('DELETE', '/v1/settings/model/profiles/writer');
      expect(modelFieldRes.status).toBeGreaterThanOrEqual(400);

      const cfg = await loadConfig(paths.config);
      expect(cfg?.model.profiles.some((profile) => profile.alias === 'research')).toBe(true);
      expect(cfg?.model.profiles.some((profile) => profile.alias === 'writer')).toBe(true);
    });

    test('renames a profile atomically with default and agent references', async () => {
      await json('PUT', '/v1/settings/model/providers/oai', {
        provider: { id: 'oai', label: 'OpenAI-compatible', type: 'openai-compatible', baseUrl: 'https://api.test/v1' }
      });
      await json('PUT', '/v1/settings/model/profiles/default', {
        profile: profile('default', 'gpt-x')
      });
      await json('PUT', '/v1/settings/model/profiles/research', {
        profile: profile('research', 'gpt-research')
      });
      await json('PUT', '/v1/settings/model/default', { alias: 'research' });
      await json('POST', '/v1/agents', { name: 'Researcher', modelAlias: 'research', capabilities: [] });
      await json('POST', '/v1/agents', { name: 'Writer', model: 'research', capabilities: [] });

      const res = await json('PATCH', '/v1/settings/model/profiles/research/alias', { alias: 'writer' });
      expect(res.status).toBe(200);

      const cfg = await loadConfig(paths.config);
      expect(cfg?.model.default).toBe('writer');
      expect(cfg?.model.profiles.some((profile) => profile.alias === 'research')).toBe(false);
      expect(cfg?.model.profiles.some((profile) => profile.alias === 'writer')).toBe(true);
      expect(cfg?.agent.agents.find((agent) => agent.name === 'Researcher')?.modelAlias).toBe('writer');
      expect(cfg?.agent.agents.find((agent) => agent.name === 'Writer')?.model).toBe('writer');
    });

    test('renaming the default profile keeps init status initialized', async () => {
      await json('PUT', '/v1/settings/model/providers/oai', {
        provider: { id: 'oai', label: 'OpenAI-compatible', type: 'openai-compatible', baseUrl: 'https://api.test/v1' }
      });
      await json('POST', '/v1/settings/model/providers/oai/credentials', {
        label: 'primary',
        authType: 'api_key',
        accessToken: 'sk-test'
      });
      await json('PUT', '/v1/settings/model/profiles/default', {
        profile: profile('default', 'gpt-x')
      });
      await json('PUT', '/v1/settings/model/default', { alias: 'default' });
      const agent = (await (
        await json('POST', '/v1/agents', { name: 'Writer', modelAlias: 'default', capabilities: [] })
      ).json()) as { agent: { id: string } };
      await json('PUT', '/v1/agents/default', { agentId: agent.agent.id });

      const rename = await json('PATCH', '/v1/settings/model/profiles/default/alias', { alias: 'writer' });
      expect(rename.status).toBe(200);

      const status = (await (await json('GET', '/v1/init/status')).json()) as {
        initialized: boolean;
        missing: string[];
      };
      expect(status).toMatchObject({ initialized: true, missing: [] });
    });

    test('model roles round-trip (GET → PUT → GET) and persist to config.json', async () => {
      await json('PUT', '/v1/settings/model/providers/oai', {
        provider: { id: 'oai', label: 'OpenAI-compatible', type: 'openai-compatible', baseUrl: 'https://api.test/v1' }
      });
      await json('PUT', '/v1/settings/model/profiles/default', {
        profile: profile('default', 'gpt-x')
      });
      await json('PUT', '/v1/settings/model/default', { alias: 'default' });

      const initial = (await (await json('GET', '/v1/settings/model/roles')).json()) as {
        roles: Record<string, string>;
      };
      expect(initial.roles).toBeDefined();

      await json('PUT', '/v1/settings/model/roles', {
        roles: { vision: 'oai:gpt-vision', embedding: 'oai:text-embedding-3-small' }
      });

      const after = (await (await json('GET', '/v1/settings/model/roles')).json()) as { roles: Record<string, string> };
      expect(after.roles.vision).toBe('oai:gpt-vision');
      expect(after.roles.embedding).toBe('oai:text-embedding-3-small');

      const cfg = await loadConfig(paths.config);
      expect(cfg?.model.profiles.find((profile) => profile.alias === 'default')?.routes.embedding).toEqual({
        provider: 'oai',
        modelId: 'text-embedding-3-small'
      });
    });

    test('model roles are scoped to the active default profile', async () => {
      await json('PUT', '/v1/settings/model/providers/oai', {
        provider: { id: 'oai', label: 'OpenAI-compatible', type: 'openai-compatible', baseUrl: 'https://api.test/v1' }
      });
      await json('PUT', '/v1/settings/model/profiles/default', {
        profile: profile('default', 'gpt-x')
      });
      await json('PUT', '/v1/settings/model/profiles/fast', {
        profile: profile('fast', 'gpt-fast')
      });
      await json('PUT', '/v1/settings/model/default', { alias: 'fast' });

      await json('PUT', '/v1/settings/model/roles', { roles: { image: 'oai:image-model' } });

      const cfg = await loadConfig(paths.config);
      expect(cfg?.model.profiles.find((profile) => profile.alias === 'fast')?.routes.image).toEqual({
        provider: 'oai',
        modelId: 'image-model'
      });
      expect(cfg?.model.profiles.find((profile) => profile.alias === 'default')?.routes.image).toBeUndefined();
    });

    test('POST /v1/settings/model/embeddings/reindex resolves and returns ok', async () => {
      const res = await json('POST', '/v1/settings/model/embeddings/reindex');
      expect(res.status).toBe(200);
      expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });
    });
  });
}
