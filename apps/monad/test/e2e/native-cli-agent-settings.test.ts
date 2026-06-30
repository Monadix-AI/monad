import type { MonadPaths } from '@monad/home';

import { describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome, loadAll, loadAuth, loadConfig } from '@monad/home';

import { ModelService } from '@/handlers/settings/model/index.ts';
import { createHttpTransport } from '@/transports/http.ts';
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

const agentView = () => ({
  name: 'codex',
  provider: 'codex',
  command: 'codex',
  args: ['--ask-for-approval', 'on-request'],
  enabled: true,
  defaultLaunchMode: 'pty',
  allowDangerousMode: false,
  approvalOwnership: 'provider-owned'
});

type Call = (method: string, path: string, body?: unknown) => Promise<Response>;
interface AgentsBody {
  agents: ReturnType<typeof agentView>[];
}

async function setup(): Promise<{ dir: string; paths: MonadPaths; app: ReturnType<typeof createHttpTransport> }> {
  const dir = join(tmpdir(), `monad-native-cli-settings-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`);
  const paths = makePaths(dir);
  await initMonadHome(paths);
  const cfg = await loadConfig(paths.config);
  if (!cfg) throw new Error('config missing after init');
  const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry());
  const app = createHttpTransport(buildHandlers(mockModel(), { paths, modelService }));
  return { dir, paths, app };
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body)
});

async function runCrud(call: Call, paths: MonadPaths): Promise<void> {
  let res = await call('GET', '/v1/settings/native-cli-agents');
  expect(res.status).toBe(200);
  expect(((await res.json()) as AgentsBody).agents).toEqual([]);

  res = await call('PUT', '/v1/settings/native-cli-agents', { agent: agentView() });
  expect(res.status).toBe(200);

  res = await call('GET', '/v1/settings/native-cli-agents');
  const { agents } = (await res.json()) as AgentsBody;
  expect(agents).toHaveLength(1);
  expect(agents[0]?.approvalOwnership).toBe('provider-owned');
  expect(agents[0]?.provider).toBe('codex');

  expect((await loadConfig(paths.config))?.nativeCliAgents).toHaveLength(1);
  expect((await loadAll(paths.config, paths.profile))?.nativeCliAgents).toHaveLength(1);

  res = await call('POST', '/v1/settings/native-cli-agents/codex/disable');
  expect(res.status).toBe(200);
  res = await call('GET', '/v1/settings/native-cli-agents');
  expect(((await res.json()) as AgentsBody).agents[0]?.enabled).toBe(false);

  res = await call('POST', '/v1/settings/native-cli-agents/codex/enable');
  expect(res.status).toBe(200);
  res = await call('GET', '/v1/settings/native-cli-agents');
  expect(((await res.json()) as AgentsBody).agents[0]?.enabled).toBe(true);

  res = await call('DELETE', '/v1/settings/native-cli-agents/codex');
  expect(res.status).toBe(200);
  res = await call('GET', '/v1/settings/native-cli-agents');
  expect(((await res.json()) as AgentsBody).agents).toEqual([]);
}

async function runPresets(call: Call): Promise<void> {
  const res = await call('GET', '/v1/settings/native-cli-agents/presets');
  expect(res.status).toBe(200);
  const { presets } = (await res.json()) as { presets: { id: string; command: string; defaultLaunchMode: string }[] };
  expect(presets.map((p) => p.id).sort()).toEqual(['claude-code', 'codex', 'gemini']);
  expect(presets.every((p) => p.defaultLaunchMode === 'pty')).toBe(true);
  expect(presets.find((p) => p.id === 'codex')?.command).toBe('codex');
  expect(presets.find((p) => p.id === 'gemini')?.command).toBe('gemini');
}

async function runValidation(call: Call, paths: MonadPaths): Promise<void> {
  let res = await call('PUT', '/v1/settings/native-cli-agents', {
    agent: { ...agentView(), command: '   ' }
  });
  expect(res.status).not.toBe(200);

  res = await call('PUT', '/v1/settings/native-cli-agents', {
    agent: { ...agentView(), command: 'codex;rm' }
  });
  expect(res.status).not.toBe(200);

  res = await call('PUT', '/v1/settings/native-cli-agents', {
    agent: { ...agentView(), env: { 'BAD KEY': 'value' } }
  });
  expect(res.status).not.toBe(200);

  res = await call('PUT', '/v1/settings/native-cli-agents', {
    agent: { ...agentView(), env: { GOOD_KEY: 'bad\u0000value' } }
  });
  expect(res.status).not.toBe(200);

  expect((await loadConfig(paths.config))?.nativeCliAgents).toEqual([]);
}

for (const kind of TRANSPORTS) {
  describe(`native-cli-agent-settings over ${kind}`, () => {
    test('CRUD + enable/disable persists to config.json', async () => {
      const { dir, paths, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runCrud((m, p, b) => t.fetch(p, jsonInit(m, b)), paths);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('invite presets list direct native CLI providers', async () => {
      const { dir, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runPresets((m, p, b) => t.fetch(p, jsonInit(m, b)));
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('rejects an upsert with a blank command', async () => {
      const { dir, paths, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runValidation((m, p, b) => t.fetch(p, jsonInit(m, b)), paths);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
}
