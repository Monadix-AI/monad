import type { MonadPaths } from '@monad/environment';
import type { MeshAgentProviderAdapter } from '@monad/sdk-atom';

import { describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinAgentAdapters } from '@monad/atoms/agent-adapters';
import { agentConfigSchema, initMonadHome, loadAll, loadAuth, loadConfig, saveAll } from '@monad/environment';
import { httpErrorSchema } from '@monad/protocol';

import { ModelService } from '#/handlers/settings/model/index.ts';
import { registerAgentAdapterImpl } from '#/services/mesh-agent/index.ts';
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

const agentView = () => ({
  name: 'codex',
  provider: 'codex',
  command: 'codex-settings-test',
  args: ['--ask-for-approval', 'on-request'],
  modelOptions: ['custom-codex'],
  adapterSettings: {
    configProfile: 'work',
    useExperimentalGateway: true
  },
  enabled: true,
  allowAutopilot: false,
  approvalOwnership: 'provider-owned'
});

const THIRD_PARTY_IMPORT_PATH = join(tmpdir(), 'monad-third-party-migrator-settings');

const thirdPartyMigrationAdapter: MeshAgentProviderAdapter = {
  events: { projectLive: () => ({ events: [] }) },
  provider: 'third-party-migrator',
  icon: { title: 'Third Party Migrator', path: 'M4 4h16v16H4z' },
  productIcon: 'third-party-migrator',
  label: 'Third Party Migrator',
  detect: () => ({
    id: 'third-party-migrator',
    label: 'Third Party Migrator',
    provider: 'third-party-migrator',
    productIcon: 'third-party-migrator',
    command: 'third-party',
    args: [],
    installHint: 'Install third-party',
    installUrl: 'https://example.com/third-party',
    installed: true,
    capabilities: {
      auth: 'none',
      events: 'none',
      resume: 'pty',
      approval: 'provider-owned',
      settingsImport: true
    }
  }),
  listSupportedModels: () => [],
  buildAuthLaunch: () => ({ argv: ['third-party'], cwd: process.cwd() }),
  buildAuthStatusLaunch: () => ({ argv: ['third-party'], cwd: process.cwd() }),
  authStatus: () => ({
    launch: {
      argv: ['third-party'],
      cwd: process.cwd()
    },
    parse: () => 'unknown'
  }),
  parseAuthStatus: () => 'unknown',
  settingsImport: {
    detect: (probes) =>
      probes?.exists(THIRD_PARTY_IMPORT_PATH)
        ? [
            {
              provider: 'third-party-migrator',
              label: 'Third Party Migrator',
              path: THIRD_PARTY_IMPORT_PATH,
              source: 'default',
              scope: 'global'
            }
          ]
        : [],
    preview: async ({ path }) => ({
      provider: 'third-party-migrator',
      path: path ?? THIRD_PARTY_IMPORT_PATH,
      sources: [{ path: path ?? THIRD_PARTY_IMPORT_PATH, scope: 'manual' }],
      warnings: [],
      items: [
        {
          id: 'meshAgents:third-party-migrator',
          hash: 'third-party-hash',
          category: 'meshAgents',
          source: path ?? THIRD_PARTY_IMPORT_PATH,
          target: 'third-party-migrator',
          action: 'add',
          reason: 'third-party adapter contract maps settings without daemon provider switch',
          risk: 'low',
          agent: {
            name: 'third-party-migrator',
            provider: 'third-party-migrator',
            productIcon: 'third-party-migrator',
            command: 'third-party',
            args: ['--profile', 'default'],
            enabled: true,
            allowAutopilot: false,
            approvalOwnership: 'provider-owned'
          }
        }
      ]
    })
  }
};

registerAgentAdapterImpl(thirdPartyMigrationAdapter);

type Call = (method: string, path: string, body?: unknown) => Promise<Response>;
interface AgentsBody {
  agents: ReturnType<typeof agentView>[];
}

async function setup(options: { monadAgent?: boolean } = {}): Promise<{
  dir: string;
  paths: MonadPaths;
  app: ReturnType<typeof createHttpTransport>;
}> {
  const dir = join(tmpdir(), `monad-mesh-agent-settings-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`);
  const paths = makePaths(dir);
  await initMonadHome(paths);
  const cfg = await loadConfig(paths);
  if (!cfg) throw new Error('config missing after init');
  if (options.monadAgent) {
    cfg.agent.agents = [
      agentConfigSchema.parse({
        id: 'agt_000000000000',
        name: 'Reviewer',
        memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 }
      })
    ];
    await saveAll(paths, cfg);
  }
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
  let res = await call('GET', '/v1/mesh/agents');
  expect(res.status).toBe(200);
  expect(((await res.json()) as AgentsBody).agents).toEqual([]);

  res = await call('PUT', '/v1/mesh/agents/codex', { agent: agentView() });
  expect(res.status).toBe(200);

  res = await call('GET', '/v1/mesh/agents');
  const { agents } = (await res.json()) as AgentsBody;
  expect(agents).toHaveLength(1);
  expect(agents[0]?.approvalOwnership).toBe('provider-owned');
  expect(agents[0]?.provider).toBe('codex');
  expect(agents[0]?.modelOptions).toEqual([]);
  expect(agents[0]?.adapterSettings).toEqual({
    configProfile: 'work',
    useExperimentalGateway: true
  });

  expect((await loadConfig(paths))?.meshAgents).toHaveLength(1);
  expect((await loadConfig(paths))?.meshAgents[0]?.adapterSettings).toEqual({
    configProfile: 'work',
    useExperimentalGateway: true
  });
  const loaded = await loadAll(paths);
  expect(loaded?.meshAgents).toHaveLength(1);

  res = await call('POST', '/v1/mesh/agents/codex/disable');
  expect(res.status).toBe(200);
  res = await call('GET', '/v1/mesh/agents');
  expect(((await res.json()) as AgentsBody).agents[0]?.enabled).toBe(false);

  res = await call('POST', '/v1/mesh/agents/codex/enable');
  expect(res.status).toBe(200);
  res = await call('GET', '/v1/mesh/agents');
  expect(((await res.json()) as AgentsBody).agents[0]?.enabled).toBe(true);

  res = await call('DELETE', '/v1/mesh/agents/codex');
  expect(res.status).toBe(200);
  res = await call('GET', '/v1/mesh/agents');
  expect(((await res.json()) as AgentsBody).agents).toEqual([]);
}

async function runGetSingle(call: Call): Promise<void> {
  await call('PUT', '/v1/mesh/agents/codex', { agent: agentView() });

  let res = await call('GET', '/v1/mesh/agents/codex');
  expect(res.status).toBe(200);
  const { agent } = (await res.json()) as { agent: ReturnType<typeof agentView> };
  expect(agent.name).toBe('codex');
  expect(agent.provider).toBe('codex');

  res = await call('GET', '/v1/mesh/agents/does-not-exist');
  expect(res.status).toBe(404);

  await call('DELETE', '/v1/mesh/agents/codex');
}

async function runNotFound(call: Call): Promise<void> {
  let res = await call('POST', '/v1/mesh/agents/does-not-exist/enable');
  expect(res.status).toBe(404);

  res = await call('POST', '/v1/mesh/agents/does-not-exist/disable');
  expect(res.status).toBe(404);

  res = await call('DELETE', '/v1/mesh/agents/does-not-exist');
  expect(res.status).toBe(404);
}

async function runAuthStatusNotFound(call: Call): Promise<void> {
  const expectNotFound = async (response: Response, agentName: string): Promise<void> => {
    const body = httpErrorSchema.parse(await response.json());
    expect(body).toEqual({
      error: `MeshAgent not found or disabled: ${agentName}`,
      code: 'MESH_AGENT_NOT_FOUND',
      retryable: false,
      requestId: expect.stringMatching(/^req_[0-9a-zA-Z]{12}$/)
    });
  };

  let res = await call('GET', '/v1/mesh/agents/does-not-exist/auth/status');
  expect(res.status).toBe(404);
  await expectNotFound(res, 'does-not-exist');

  res = await call('POST', '/v1/mesh/agents/does-not-exist/auth/start');
  expect(res.status).toBe(404);
  await expectNotFound(res, 'does-not-exist');

  await call('PUT', '/v1/mesh/agents/codex', { agent: agentView() });
  await call('POST', '/v1/mesh/agents/codex/disable');
  res = await call('GET', '/v1/mesh/agents/codex/auth/status');
  expect(res.status).toBe(404);
  await expectNotFound(res, 'codex');

  res = await call('POST', '/v1/mesh/agents/codex/auth/start');
  expect(res.status).toBe(404);
  await expectNotFound(res, 'codex');
}

async function runPresets(call: Call): Promise<void> {
  for (const adapter of builtinAgentAdapters) {
    const probeFreeAdapter = { ...adapter };
    delete probeFreeAdapter.argumentSupport;
    registerAgentAdapterImpl({ ...probeFreeAdapter, modelOptions: () => ({ resolve: async () => [] }) });
  }
  try {
    const res = await call('GET', '/v1/mesh/agents/presets');
    expect(res.status).toBe(200);
    const { presets } = (await res.json()) as {
      presets: {
        id: string;
        command: string;
        settings?: Array<{ key: string; kind: string }>;
      }[];
    };
    const presetIds = presets.map((p) => p.id);
    for (const id of ['claude-code', 'codex', 'gemini', 'hermes', 'openclaw', 'qwen']) {
      expect(presetIds).toContain(id);
    }
    expect(presets.find((p) => p.id === 'codex')?.command).toBe('codex');
    expect(presets.find((p) => p.id === 'gemini')?.command).toBe('gemini');
    expect(presets.find((p) => p.id === 'qwen')?.command).toBe('qwen');
    expect(presets.find((p) => p.id === 'openclaw')?.command).toBe('openclaw');
    expect(presets.find((p) => p.id === 'hermes')?.command).toBe('hermes');
    expect(
      presets.find((p) => p.id === 'codex')?.settings?.map((setting) => [setting.key, setting.kind])
    ).toContainEqual(['allowAutopilot', 'switch']);
    const refresh = await call('POST', '/v1/mesh/agents/refresh');
    expect({ status: refresh.status, body: await refresh.json() }).toEqual({ status: 200, body: { ok: true } });
    const cached = await call('GET', '/v1/mesh/agents/presets');
    expect({
      status: cached.status,
      presetIds: ((await cached.json()) as { presets: { id: string }[] }).presets.map((p) => p.id)
    }).toEqual({
      status: 200,
      presetIds
    });
  } finally {
    for (const adapter of builtinAgentAdapters) registerAgentAdapterImpl(adapter);
  }
}

async function runValidation(call: Call, paths: MonadPaths): Promise<void> {
  let res = await call('PUT', '/v1/mesh/agents/codex', {
    agent: { ...agentView(), command: '   ' }
  });
  expect(res.status).not.toBe(200);

  res = await call('PUT', '/v1/mesh/agents/codex', {
    agent: { ...agentView(), command: 'codex;rm' }
  });
  expect(res.status).not.toBe(200);

  res = await call('PUT', '/v1/mesh/agents/codex', {
    agent: { ...agentView(), env: { 'BAD KEY': 'value' } }
  });
  expect(res.status).not.toBe(200);

  res = await call('PUT', '/v1/mesh/agents/codex', {
    agent: { ...agentView(), env: { GOOD_KEY: 'bad\u0000value' } }
  });
  expect(res.status).not.toBe(200);

  expect((await loadConfig(paths))?.meshAgents).toEqual([]);
}

async function runInvitableMonadAgent(call: Call): Promise<void> {
  const monadIcon = builtinAgentAdapters.find((adapter) => adapter.provider === 'monad')?.icon;
  if (!monadIcon) throw new Error('Expected Monad adapter icon');
  let res = await call('GET', '/v1/mesh/agents');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ agents: [] });

  res = await call('GET', '/v1/mesh/invitable-agents');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    agents: [
      {
        name: 'monad--agt_000000000000',
        displayName: 'Reviewer',
        provider: 'monad',
        productIcon: 'monad',
        icon: monadIcon,
        enabled: true,
        allowAutopilot: false,
        capabilities: {
          auth: 'none',
          events: 'provider-owned',
          resume: 'structured',
          approval: 'provider-owned',
          autopilot: true,
          fastMode: false,
          approvalProxy: true
        },
        modelOptions: [],
        reasoningEfforts: [],
        source: 'monad-agent'
      }
    ]
  });

  const projectRes = await call('POST', '/v1/workplace/projects', {
    title: 'direct Monad invitation'
  });
  expect(projectRes.status).toBe(201);
  const { projectId } = (await projectRes.json()) as { projectId: string };
  const sessionRes = await call('POST', `/v1/projects/${projectId}/sessions`, {
    title: 'direct Monad invitation'
  });
  expect(sessionRes.status).toBe(201);
  const { sessionId } = (await sessionRes.json()) as { sessionId: string };
  const inviteRes = await call('POST', `/v1/sessions/${sessionId}/members`, {
    type: 'mesh-agent',
    name: 'monad--agt_000000000000',
    settings: { managedProjectAgent: false }
  });
  expect(inviteRes.status).toBe(201);
  const invited = (await inviteRes.json()) as { member: unknown; binding: unknown };
  const listRes = await call('GET', `/v1/sessions/${sessionId}/members`);
  expect(listRes.status).toBe(200);
  expect(await listRes.json()).toEqual({ members: [invited] });
}

for (const kind of TRANSPORTS) {
  describe(`mesh-agent-settings over ${kind}`, () => {
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

    test('get single agent by name, 404 for unknown name', async () => {
      const { dir, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runGetSingle((m, p, b) => t.fetch(p, jsonInit(m, b)));
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('enable/disable/remove 404 for an unknown agent name', async () => {
      const { dir, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runNotFound((m, p, b) => t.fetch(p, jsonInit(m, b)));
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('auth status returns 404 for unknown or disabled agents', async () => {
      const { dir, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runAuthStatusNotFound((m, p, b) => t.fetch(p, jsonInit(m, b)));
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('invite presets list direct MeshAgent providers', async () => {
      const { dir, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runPresets((m, p, b) => t.fetch(p, jsonInit(m, b)));
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('lists configured Monad Agents for invitation without a Mesh connection', async () => {
      const { dir, app } = await setup({ monadAgent: true });
      const t = serveTransport(kind, app);
      try {
        await runInvitableMonadAgent((m, p, b) => t.fetch(p, jsonInit(m, b)));
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
