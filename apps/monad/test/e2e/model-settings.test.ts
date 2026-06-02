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
        profile: { alias: 'default', provider: 'oai', modelId: 'gpt-x', params: { temperature: 0.5 }, fallbacks: [] }
      });
      await json('PUT', '/v1/settings/model/default', { alias: 'default' });
      const profiles = (await (await json('GET', '/v1/settings/model/profiles')).json()) as {
        defaultAlias: string;
        profiles: Array<Record<string, unknown>>;
      };
      expect(profiles.defaultAlias).toBe('default');
      expect(profiles.profiles).toEqual(
        expect.arrayContaining([expect.objectContaining({ alias: 'default', provider: 'oai', modelId: 'gpt-x' })])
      );

      const cfg = await loadConfig(paths.config);
      expect(cfg?.model.profiles.find((profile) => profile.alias === 'default')?.modelId).toBe('gpt-x');
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
        profile: { alias: 'default', provider: 'oai', modelId: 'gpt-x', params: {}, fallbacks: [], roles: {} }
      });
      await json('PUT', '/v1/settings/model/profiles/fast', {
        profile: { alias: 'fast', provider: 'oai', modelId: 'gpt-fast', params: {}, fallbacks: [], roles: {} }
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
        profile: { alias: 'default', provider: 'oai', modelId: 'gpt-x', params: {}, fallbacks: [], roles: {} }
      });

      const res = await json('DELETE', '/v1/settings/model/profiles/default');
      expect(res.status).toBeGreaterThanOrEqual(400);

      const cfg = await loadConfig(paths.config);
      expect(cfg?.model.profiles.some((profile) => profile.alias === 'default')).toBe(true);
    });

    test('rejects deleting whichever profile is currently set as default', async () => {
      await json('PUT', '/v1/settings/model/providers/oai', {
        provider: { id: 'oai', label: 'OpenAI-compatible', type: 'openai-compatible', baseUrl: 'https://api.test/v1' }
      });
      await json('PUT', '/v1/settings/model/profiles/default', {
        profile: { alias: 'default', provider: 'oai', modelId: 'gpt-x', params: {}, fallbacks: [], roles: {} }
      });
      await json('PUT', '/v1/settings/model/profiles/fast', {
        profile: { alias: 'fast', provider: 'oai', modelId: 'gpt-fast', params: {}, fallbacks: [], roles: {} }
      });
      await json('PUT', '/v1/settings/model/default', { alias: 'fast' });

      const res = await json('DELETE', '/v1/settings/model/profiles/fast');
      expect(res.status).toBeGreaterThanOrEqual(400);

      const cfg = await loadConfig(paths.config);
      expect(cfg?.model.profiles.some((profile) => profile.alias === 'fast')).toBe(true);
    });

    test('model roles round-trip (GET → PUT → GET) and persist to config.json', async () => {
      await json('PUT', '/v1/settings/model/providers/oai', {
        provider: { id: 'oai', label: 'OpenAI-compatible', type: 'openai-compatible', baseUrl: 'https://api.test/v1' }
      });
      await json('PUT', '/v1/settings/model/profiles/default', {
        profile: { alias: 'default', provider: 'oai', modelId: 'gpt-x', params: {}, fallbacks: [], roles: {} }
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
      expect(cfg?.model.profiles.find((profile) => profile.alias === 'default')?.roles.embedding).toBe(
        'oai:text-embedding-3-small'
      );
    });

    test('model roles are scoped to the active default profile', async () => {
      await json('PUT', '/v1/settings/model/providers/oai', {
        provider: { id: 'oai', label: 'OpenAI-compatible', type: 'openai-compatible', baseUrl: 'https://api.test/v1' }
      });
      await json('PUT', '/v1/settings/model/profiles/default', {
        profile: { alias: 'default', provider: 'oai', modelId: 'gpt-x', params: {}, fallbacks: [], roles: {} }
      });
      await json('PUT', '/v1/settings/model/profiles/fast', {
        profile: { alias: 'fast', provider: 'oai', modelId: 'gpt-fast', params: {}, fallbacks: [], roles: {} }
      });
      await json('PUT', '/v1/settings/model/default', { alias: 'fast' });

      await json('PUT', '/v1/settings/model/roles', { roles: { image: 'oai:image-model' } });

      const cfg = await loadConfig(paths.config);
      expect(cfg?.model.profiles.find((profile) => profile.alias === 'fast')?.roles.image).toBe('oai:image-model');
      expect(cfg?.model.profiles.find((profile) => profile.alias === 'default')?.roles.image).toBeUndefined();
    });

    test('POST /v1/settings/model/embeddings/reindex resolves and returns ok', async () => {
      const res = await json('POST', '/v1/settings/model/embeddings/reindex');
      expect(res.status).toBe(200);
      expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });
    });
  });
}
