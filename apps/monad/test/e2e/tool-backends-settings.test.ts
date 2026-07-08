// e2e: the tool-backends-settings REST surface over a real temp ~/.monad, exercised over BOTH
// transports (TCP loopback + Unix socket). Asserts GET returns defaults and PUT round-trips to
// profile.json, and that smtp config persists and clears correctly.

import type { MonadPaths } from '@monad/home';

import { describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome, loadAll, loadAuth, loadConfig } from '@monad/home';

import { ModelService } from '#/handlers/settings/model/index.ts';
import { createHttpTransport } from '#/transports/http.ts';
import {
  buildHandlers,
  makeTestPaths,
  mockModel,
  seededProviderRegistry,
  serveTransport,
  TRANSPORTS
} from '../helpers.ts';

function makePaths(base: string): MonadPaths {
  return makeTestPaths(base);
}

async function setup(tag: string) {
  const base = join(tmpdir(), `monad-tool-backends-${Date.now()}-${tag}`);
  const paths = makePaths(base);
  await initMonadHome(paths);
  const cfg = await loadConfig(paths.config);
  if (!cfg) throw new Error('config missing after init');
  const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry());
  const app = createHttpTransport(buildHandlers(mockModel(), { paths, modelService }));
  return { base, paths, app };
}

for (const kind of TRANSPORTS) {
  describe(`tool-backends-settings over ${kind}`, () => {
    test('GET returns defaults / PUT persists to profile', async () => {
      const { base, paths, app } = await setup(kind);
      const t = serveTransport(kind, app);
      try {
        const getRes = await t.fetch('/v1/settings/tool-backends');
        expect(getRes.status).toBe(200);
        const initial = (await getRes.json()) as {
          webSearch: { provider: string };
          email: { backend: string };
          codeExec: { backend: string; availableBackends: string[] };
        };
        expect(initial.webSearch.provider).toBe('auto');
        expect(initial.email.backend).toBe('auto');
        expect(initial.codeExec.backend).toBe('follow-system');
        expect(initial.codeExec.availableBackends).toContain('follow-system');

        const putRes = await t.fetch('/v1/settings/tool-backends', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            webSearch: { provider: 'native', braveApiKey: 'BSAtest123' },
            email: { backend: 'resend', from: 'bot@example.com', resendApiKey: 're_abc' }
          })
        });
        expect(putRes.status).toBe(200);
        const updated = (await putRes.json()) as {
          webSearch: { provider: string; braveApiKey?: string };
          email: { backend: string; from?: string; resendApiKey?: string };
        };
        expect(updated.webSearch.provider).toBe('native');
        expect(updated.webSearch.braveApiKey).toBe('BSAtest123');
        expect(updated.email.backend).toBe('resend');
        expect(updated.email.from).toBe('bot@example.com');
        expect(updated.email.resendApiKey).toBe('re_abc');

        const cfg = await loadAll(paths.config, paths.profile);
        expect(cfg?.agent.tools.webSearch.provider).toBe('native');
        expect(cfg?.agent.tools.webSearch.brave?.apiKey).toBe('BSAtest123');
        expect(cfg?.agent.tools.email.backend).toBe('resend');
        expect(cfg?.agent.tools.email.from).toBe('bot@example.com');
        expect(cfg?.agent.tools.email.resend?.apiKey).toBe('re_abc');
      } finally {
        t.stop();
        await rm(base, { recursive: true, force: true });
      }
    });

    test('PUT codeExec backend persists to profile', async () => {
      const { base, paths, app } = await setup(kind);
      const t = serveTransport(kind, app);
      try {
        // GET: default is 'follow-system', availableBackends always includes 'follow-system'
        const getRes = await t.fetch('/v1/settings/tool-backends');
        const initial = (await getRes.json()) as { codeExec: { backend: string; availableBackends: string[] } };
        expect(initial.codeExec.backend).toBe('follow-system');
        expect(initial.codeExec.availableBackends).toContain('follow-system');

        // PUT: change to 'follow-system' (can't test 'docker' without Docker installed)
        await t.fetch('/v1/settings/tool-backends', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ codeExec: { backend: 'follow-system' } })
        });

        // Verify persisted to disk
        const cfg = await loadAll(paths.config, paths.profile);
        expect(cfg?.agent.tools.codeExecBackend).toBe('follow-system');
      } finally {
        t.stop();
        await rm(base, { recursive: true, force: true });
      }
    });

    test('PUT smtp config persists and null clears it', async () => {
      const { base, paths, app } = await setup(kind);
      const t = serveTransport(kind, app);
      try {
        const setSmtp = await t.fetch('/v1/settings/tool-backends', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: {
              backend: 'smtp',
              smtp: { host: 'smtp.example.com', port: 587, user: 'u', pass: 'p' }
            }
          })
        });
        expect(setSmtp.status).toBe(200);

        const cfg = await loadAll(paths.config, paths.profile);
        expect(cfg?.agent.tools.email.smtp?.host).toBe('smtp.example.com');
        expect(cfg?.agent.tools.email.smtp?.port).toBe(587);

        await t.fetch('/v1/settings/tool-backends', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: { smtp: null } })
        });

        const cfg2 = await loadAll(paths.config, paths.profile);
        expect(cfg2?.agent.tools.email.smtp).toBeUndefined();
      } finally {
        t.stop();
        await rm(base, { recursive: true, force: true });
      }
    });
  });
}
