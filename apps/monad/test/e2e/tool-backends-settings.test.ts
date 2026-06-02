// e2e: the tool-backends-settings REST surface over a real temp ~/.monad, exercised over BOTH
// transports (TCP loopback + Unix socket). Asserts native credentials persist in agents.json while
// GET and mutation responses expose only configured state.

import type { MonadPaths } from '@monad/environment';

import { describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome, loadAll, loadAuth, loadConfig } from '@monad/environment';

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
  const cfg = await loadConfig(paths);
  if (!cfg) throw new Error('config missing after init');
  const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry());
  const app = createHttpTransport(buildHandlers(mockModel(), { paths, modelService }));
  return { base, paths, app };
}

for (const kind of TRANSPORTS) {
  describe(`tool-backends-settings over ${kind}`, () => {
    test('GET and PUT redact native credentials while explicit updates persist', async () => {
      const { base, paths, app } = await setup(kind);
      const t = serveTransport(kind, app);
      try {
        const getRes = await t.fetch('/v1/settings/tool-backends');
        expect(getRes.status).toBe(200);
        const initial = (await getRes.json()) as {
          webSearch: { provider: string; braveApiKey: { configured: boolean } };
          email: { backend: string; resendApiKey: { configured: boolean } };
          codeExec: {
            backend: string;
            availableBackends: string[];
            e2bApiKey: { configured: boolean };
          };
        };
        expect(initial.webSearch.provider).toBe('auto');
        expect(initial.webSearch.braveApiKey).toEqual({ configured: false });
        expect(initial.email.backend).toBe('auto');
        expect(initial.email.resendApiKey).toEqual({ configured: false });
        expect(initial.codeExec.backend).toBe('follow-system');
        expect(initial.codeExec.availableBackends).toContain('follow-system');
        expect(initial.codeExec.e2bApiKey).toEqual({ configured: false });

        const putRes = await t.fetch('/v1/settings/tool-backends', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            webSearch: {
              provider: 'native',
              braveApiKey: { action: 'replace', value: 'brave-canary-secret' }
            },
            email: {
              backend: 'resend',
              from: 'bot@example.com',
              resendApiKey: { action: 'replace', value: 'resend-canary-secret' }
            },
            codeExec: {
              e2bApiKey: { action: 'replace', value: 'e2b-canary-secret' }
            }
          })
        });
        expect(putRes.status).toBe(200);
        const updated = (await putRes.json()) as {
          webSearch: { provider: string; braveApiKey: { configured: boolean } };
          email: { backend: string; from?: string; resendApiKey: { configured: boolean } };
          codeExec: { e2bApiKey: { configured: boolean } };
        };
        expect(updated.webSearch.provider).toBe('native');
        expect(updated.webSearch.braveApiKey).toEqual({ configured: true });
        expect(updated.email.backend).toBe('resend');
        expect(updated.email.from).toBe('bot@example.com');
        expect(updated.email.resendApiKey).toEqual({ configured: true });
        expect(updated.codeExec.e2bApiKey).toEqual({ configured: true });
        expect(JSON.stringify(updated)).not.toContain('canary-secret');

        let cfg = await loadAll(paths);
        expect(cfg?.agent.tools.webSearch.brave?.apiKey).toBe('brave-canary-secret');
        expect(cfg?.agent.tools.email.resend?.apiKey).toBe('resend-canary-secret');
        expect(cfg?.agent.tools.codeExecE2b?.apiKey).toBe('e2b-canary-secret');

        const metadataOnly = await t.fetch('/v1/settings/tool-backends', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ webSearch: { provider: 'brave' }, email: { from: 'next@example.com' } })
        });
        expect(metadataOnly.status).toBe(200);
        cfg = await loadAll(paths);
        expect(cfg?.agent.tools.webSearch.brave?.apiKey).toBe('brave-canary-secret');
        expect(cfg?.agent.tools.email.resend?.apiKey).toBe('resend-canary-secret');
        expect(cfg?.agent.tools.codeExecE2b?.apiKey).toBe('e2b-canary-secret');

        const remove = await t.fetch('/v1/settings/tool-backends', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            webSearch: { braveApiKey: { action: 'remove' } },
            email: { resendApiKey: { action: 'remove' } },
            codeExec: { e2bApiKey: { action: 'remove' } }
          })
        });
        expect(remove.status).toBe(200);
        const removed = (await remove.json()) as {
          webSearch: { braveApiKey: { configured: boolean } };
          email: { resendApiKey: { configured: boolean } };
          codeExec: { e2bApiKey: { configured: boolean } };
        };
        expect(removed.webSearch.braveApiKey).toEqual({ configured: false });
        expect(removed.email.resendApiKey).toEqual({ configured: false });
        expect(removed.codeExec.e2bApiKey).toEqual({ configured: false });
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
        const cfg = await loadAll(paths);
        expect(cfg?.agent.tools.codeExecBackend).toBe('follow-system');
      } finally {
        t.stop();
        await rm(base, { recursive: true, force: true });
      }
    });

    test('PUT SMTP pass supports replace, preserve, remove, and whole-config removal', async () => {
      const { base, paths, app } = await setup(kind);
      const t = serveTransport(kind, app);
      try {
        const setSmtp = await t.fetch('/v1/settings/tool-backends', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: {
              backend: 'smtp',
              smtp: {
                action: 'replace',
                value: {
                  host: 'smtp.example.com',
                  port: 587,
                  user: 'u',
                  pass: { action: 'replace', value: 'smtp-canary-secret' }
                }
              }
            }
          })
        });
        expect(setSmtp.status).toBe(200);
        const smtpView = (await setSmtp.json()) as {
          email: { smtp?: { host: string; port: number; user: string; pass: { configured: boolean } } };
        };
        expect(smtpView.email.smtp).toEqual({
          host: 'smtp.example.com',
          port: 587,
          user: 'u',
          pass: { configured: true }
        });
        expect(JSON.stringify(smtpView)).not.toContain('smtp-canary-secret');

        let cfg = await loadAll(paths);
        expect(cfg?.agent.tools.email.smtp?.host).toBe('smtp.example.com');
        expect(cfg?.agent.tools.email.smtp?.pass).toBe('smtp-canary-secret');

        await t.fetch('/v1/settings/tool-backends', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: { smtp: { action: 'replace', value: { host: 'smtp2.example.com', user: 'next' } } }
          })
        });
        cfg = await loadAll(paths);
        expect(cfg?.agent.tools.email.smtp).toMatchObject({
          host: 'smtp2.example.com',
          user: 'next',
          pass: 'smtp-canary-secret'
        });

        const removePass = await t.fetch('/v1/settings/tool-backends', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: {
              smtp: {
                action: 'replace',
                value: { host: 'smtp2.example.com', pass: { action: 'remove' } }
              }
            }
          })
        });
        const removedPassView = (await removePass.json()) as {
          email: { smtp?: { pass: { configured: boolean } } };
        };
        expect(removedPassView.email.smtp?.pass).toEqual({ configured: false });
        expect((await loadAll(paths))?.agent.tools.email.smtp?.pass).toBeUndefined();

        await t.fetch('/v1/settings/tool-backends', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: { smtp: { action: 'remove' } } })
        });
        expect((await loadAll(paths))?.agent.tools.email.smtp).toBeUndefined();
      } finally {
        t.stop();
        await rm(base, { recursive: true, force: true });
      }
    });
  });
}
