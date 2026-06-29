// e2e: the model-settings REST surface over a real temp ~/.monad. Exercises the
// provider/credential/profile/default CRUD and asserts secrets are redacted in
// responses while the full token is persisted to auth.json. Runs over both transports.

import type { MonadPaths } from '@monad/home';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome, loadAuth, loadConfig } from '@monad/home';

import { ModelService } from '@/handlers/settings/model/index.ts';
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
