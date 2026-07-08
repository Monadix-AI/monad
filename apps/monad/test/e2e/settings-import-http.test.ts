import type { MonadPaths } from '@monad/home';
import type { ImportSettingsApplyResult, ImportSettingsPreview } from '@monad/protocol';

import { describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
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
  TRANSPORTS,
  type TransportHandle
} from '../helpers.ts';

async function setup(
  kind: (typeof TRANSPORTS)[number]
): Promise<{ dir: string; paths: MonadPaths; t: TransportHandle }> {
  const dir = join(tmpdir(), `monad-settings-import-http-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`);
  const paths = makeTestPaths(dir);
  await initMonadHome(paths);
  const cfg = await loadConfig(paths.config);
  if (!cfg) throw new Error('config missing after init');
  const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry());
  const app = createHttpTransport(buildHandlers(mockModel(), { paths, modelService }));
  return { dir, paths, t: serveTransport(kind, app) };
}

const jsonInit = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

for (const kind of TRANSPORTS) {
  describe(`settings import HTTP over ${kind}`, () => {
    test('preview and selected apply round-trip through daemon route', async () => {
      const { dir, paths, t } = await setup(kind);
      const codex = join(dir, '.codex');
      await mkdir(codex, { recursive: true });
      await Bun.write(
        join(codex, 'config.toml'),
        [
          'model = "gpt-4.1"',
          '[mcp_servers.remote]',
          'url = "https://mcp.example.com/sse"',
          '[mcp_servers.local]',
          'command = "local-mcp"'
        ].join('\n')
      );
      try {
        const previewRes = await t.fetch(
          '/v1/settings/import/preview',
          jsonInit({ from: 'auto', path: codex, replace: false })
        );
        expect(previewRes.status).toBe(200);
        const preview = (await previewRes.json()) as ImportSettingsPreview;
        expect(preview.from).toBe('codex');
        expect(preview.items.map((i) => [i.category, i.target, i.action])).toContainEqual([
          'mcpServers',
          'remote',
          'add'
        ]);

        const applyRes = await t.fetch(
          '/v1/settings/import/apply',
          jsonInit({
            from: 'auto',
            path: codex,
            replace: false,
            select: ['mcpServers:remote'],
            allSafe: false,
            hashes: {
              'mcpServers:remote': preview.items.find((i) => i.id === 'mcpServers:remote')?.hash
            }
          })
        );
        expect(applyRes.status).toBe(200);
        const result = (await applyRes.json()) as ImportSettingsApplyResult;
        expect(result.applied).toEqual(['mcpServers:remote']);
        const cfg = await loadAll(paths.config, paths.profile);
        expect(cfg?.mcpServers.map((s) => s.name)).toContain('remote');
        expect(cfg?.mcpServers.map((s) => s.name)).not.toContain('local');
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
}
