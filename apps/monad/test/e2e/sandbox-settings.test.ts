// e2e: the system-level sandbox-defaults REST surface over a real temp ~/.monad, exercised over BOTH
// transports (TCP loopback + Unix socket). Sandbox lives in the SYSTEM slice, so edits persist to
// config.json (via saveSystemConfig), like acp-agents — NOT profile.json.

import type { MonadPaths } from '@monad/home';
import type { SandboxSettingsResponse } from '@monad/protocol';

import { describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome, loadAuth, loadConfig } from '@monad/home';

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

function makePaths(base: string): MonadPaths {
  return makeTestPaths(base, { skillsLock: join(base, 'atoms', 'skills.lock') });
}

async function setup(): Promise<{ dir: string; paths: MonadPaths; app: ReturnType<typeof createHttpTransport> }> {
  const dir = join(tmpdir(), `monad-sandboxset-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`);
  const paths = makePaths(dir);
  await initMonadHome(paths);
  const cfg = await loadConfig(paths.config);
  if (!cfg) throw new Error('config missing after init');
  const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry());
  const app = createHttpTransport(buildHandlers(mockModel(), { paths, modelService }));
  return { dir, paths, app };
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body)
});

async function run(t: TransportHandle, paths: MonadPaths): Promise<void> {
  // 1. defaults from initMonadHome
  let res = await t.fetch('/v1/settings/sandbox');
  expect(res.status).toBe(200);
  let body = (await res.json()) as SandboxSettingsResponse;
  expect(body.sandbox.mode).toBe('workspace');
  expect(body.globalSandbox.enabled).toBe(false);

  // 2. update sandbox defaults + enable the global ceiling
  res = await t.fetch(
    '/v1/settings/sandbox',
    json('PUT', {
      sandbox: { mode: 'home', confine: false, net: 'filtered', allowedDomains: ['example.com'], hostExec: 'deny' },
      globalSandbox: { enabled: true, mode: 'workspace' }
    })
  );
  expect(res.status).toBe(200);
  body = (await res.json()) as SandboxSettingsResponse;
  expect(body.sandbox).toEqual({
    mode: 'home',
    confine: false,
    net: 'filtered',
    allowedDomains: ['example.com'],
    hostExec: 'deny'
  });
  expect(body.globalSandbox).toEqual({ enabled: true, mode: 'workspace' });

  // 3. persisted to config.json (SYSTEM slice), reflected on a fresh GET
  const sys = await loadConfig(paths.config);
  expect(sys?.agent.sandbox.mode).toBe('home');
  expect(sys?.agent.sandbox.allowedDomains).toEqual(['example.com']);
  expect(sys?.agent.globalSandbox).toEqual({ enabled: true, mode: 'workspace' });
  res = await t.fetch('/v1/settings/sandbox');
  expect(((await res.json()) as SandboxSettingsResponse).sandbox.hostExec).toBe('deny');

  // 4. partial patch leaves untouched fields intact
  res = await t.fetch('/v1/settings/sandbox', json('PUT', { sandbox: { confine: true } }));
  body = (await res.json()) as SandboxSettingsResponse;
  expect(body.sandbox.confine).toBe(true);
  expect(body.sandbox.mode).toBe('home'); // unchanged
  expect(body.globalSandbox.enabled).toBe(true); // unchanged
}

for (const kind of TRANSPORTS) {
  describe(`sandbox settings over ${kind}`, () => {
    test('get/set persists to config.json', async () => {
      const { dir, paths, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        await run(t, paths);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
}
