import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome } from '@monad/home';

import { ModelService } from '#/handlers/settings/model/index.ts';
import { ModelCatalogService } from '#/services/model-catalog.ts';
import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, makeTestPaths, mockModel, seededProviderRegistry, serveTransport } from '../helpers.ts';

let healthServer: { port: number; stop(force?: boolean): void } | undefined;

afterEach(() => {
  healthServer?.stop(true);
  healthServer = undefined;
});

test('network settings probe checks a daemon health endpoint over HTTP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monad-network-e2e-'));
  try {
    const paths = makeTestPaths(dir);
    await initMonadHome(paths);
    const cfg = (await import('@monad/home')).createDefaultConfig('prn_test00000000', 'Test');
    const modelDeps = {
      paths,
      modelService: new ModelService(paths.auth, cfg, null, seededProviderRegistry()),
      modelCatalog: new ModelCatalogService({ cachePath: join(dir, 'model-catalog.json'), log: () => {} })
    };
    const transport = serveTransport('tcp', createHttpTransport(buildHandlers(mockModel(), modelDeps)));
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ status: 'ok', version: 'test' })
    });
    if (server.port === undefined) throw new Error('expected health server port');
    healthServer = server as { port: number; stop(force?: boolean): void };

    const res = await transport.fetch('/v1/settings/network/probe', {
      body: JSON.stringify({ url: `http://127.0.0.1:${healthServer.port}` }),
      headers: { 'content-type': 'application/json' },
      method: 'POST'
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, status: 200 });
    await transport.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
