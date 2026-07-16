import type { MonadPaths } from '@monad/environment';
import type { ExternalAgentProviderAdapter } from '@monad/sdk-atom';

import { describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome, loadAll, loadAuth, loadConfig } from '@monad/environment';

import { ModelService } from '#/handlers/settings/model/index.ts';
import { registerAgentAdapterImpl } from '#/services/external-agent/index.ts';
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
  projectTemplates: [
    {
      id: 'reviewer',
      displayName: 'Reviewer',
      modelId: 'gpt-5.5',
      reasoningEffort: 'high',
      speed: 'fast' as const,
      customPrompt: 'Review changes only.'
    }
  ],
  adapterSettings: {
    configProfile: 'work',
    useExperimentalGateway: true
  },
  enabled: true,
  defaultLaunchMode: 'pty',
  allowAutopilot: false,
  approvalOwnership: 'provider-owned'
});

const THIRD_PARTY_IMPORT_PATH = join(tmpdir(), 'monad-third-party-migrator-settings');

const thirdPartyMigrationAdapter: ExternalAgentProviderAdapter = {
  provider: 'third-party-migrator',
  productIcon: 'third-party-migrator',
  label: 'Third Party Migrator',
  detect: () => ({
    id: 'third-party-migrator',
    label: 'Third Party Migrator',
    provider: 'third-party-migrator',
    productIcon: 'third-party-migrator',
    command: 'third-party',
    args: [],
    defaultLaunchMode: 'pty',
    supportedLaunchModes: ['pty'],
    installHint: 'Install third-party',
    installUrl: 'https://example.com/third-party',
    installed: true,
    capabilities: {
      auth: 'none',
      history: 'none',
      resume: 'pty',
      approval: 'provider-owned',
      settingsImport: true
    }
  }),
  listSupportedModels: () => [],
  buildLaunch: () => ({
    argv: ['third-party'],
    cwd: process.cwd(),
    launchMode: 'pty',
    provider: 'third-party-migrator',
    approvalOwnership: 'provider-owned',
    capabilities: []
  }),
  buildAuthLaunch: () => ({
    argv: ['third-party'],
    cwd: process.cwd(),
    launchMode: 'pty',
    provider: 'third-party-migrator',
    approvalOwnership: 'provider-owned',
    capabilities: []
  }),
  buildAuthStatusLaunch: () => ({
    argv: ['third-party'],
    cwd: process.cwd(),
    launchMode: 'pty',
    provider: 'third-party-migrator',
    approvalOwnership: 'provider-owned',
    capabilities: []
  }),
  authStatus: () => ({
    launch: {
      argv: ['third-party'],
      cwd: process.cwd(),
      launchMode: 'pty',
      provider: 'third-party-migrator',
      approvalOwnership: 'provider-owned',
      capabilities: []
    },
    parse: () => 'unknown'
  }),
  parseAuthStatus: () => 'unknown',
  parseOutput: () => [],
  sendInput: () => {},
  resolveApproval: () => {},
  resize: () => {},
  stop: () => {},
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
          id: 'externalAgents:third-party-migrator',
          hash: 'third-party-hash',
          category: 'externalAgents',
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
            defaultLaunchMode: 'pty',
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

async function setup(): Promise<{ dir: string; paths: MonadPaths; app: ReturnType<typeof createHttpTransport> }> {
  const dir = join(tmpdir(), `monad-external-agent-settings-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`);
  const paths = makePaths(dir);
  await initMonadHome(paths);
  const cfg = await loadConfig(paths);
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
  let res = await call('GET', '/v1/settings/external-agents');
  expect(res.status).toBe(200);
  expect(((await res.json()) as AgentsBody).agents).toEqual([]);

  res = await call('PUT', '/v1/settings/external-agents/codex', { agent: agentView() });
  expect(res.status).toBe(200);

  res = await call('GET', '/v1/settings/external-agents');
  const { agents } = (await res.json()) as AgentsBody;
  expect(agents).toHaveLength(1);
  expect(agents[0]?.approvalOwnership).toBe('provider-owned');
  expect(agents[0]?.provider).toBe('codex');
  expect(agents[0]?.modelOptions).toEqual(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2']);
  expect(agents[0]?.projectTemplates).toEqual([
    {
      id: 'reviewer',
      displayName: 'Reviewer',
      modelId: 'gpt-5.5',
      reasoningEffort: 'high',
      speed: 'fast',
      customPrompt: 'Review changes only.'
    }
  ]);
  expect(agents[0]?.adapterSettings).toEqual({
    configProfile: 'work',
    useExperimentalGateway: true
  });

  expect((await loadConfig(paths))?.externalAgents).toHaveLength(1);
  expect(agents[0]?.defaultLaunchMode).toBe('pty');
  expect((await loadConfig(paths))?.externalAgents[0]?.adapterSettings).toEqual({
    configProfile: 'work',
    useExperimentalGateway: true
  });
  expect((await loadConfig(paths))?.externalAgents[0]?.projectTemplates?.[0]?.displayName).toBe('Reviewer');
  const loaded = await loadAll(paths);
  expect(loaded?.externalAgents).toHaveLength(1);
  expect(loaded?.externalAgents[0]?.projectTemplates?.[0]?.customPrompt).toBe('Review changes only.');

  res = await call('POST', '/v1/settings/external-agents/codex/disable');
  expect(res.status).toBe(200);
  res = await call('GET', '/v1/settings/external-agents');
  expect(((await res.json()) as AgentsBody).agents[0]?.enabled).toBe(false);

  res = await call('POST', '/v1/settings/external-agents/codex/enable');
  expect(res.status).toBe(200);
  res = await call('GET', '/v1/settings/external-agents');
  expect(((await res.json()) as AgentsBody).agents[0]?.enabled).toBe(true);

  res = await call('DELETE', '/v1/settings/external-agents/codex');
  expect(res.status).toBe(200);
  res = await call('GET', '/v1/settings/external-agents');
  expect(((await res.json()) as AgentsBody).agents).toEqual([]);
}

async function runGetSingle(call: Call): Promise<void> {
  await call('PUT', '/v1/settings/external-agents/codex', { agent: agentView() });

  let res = await call('GET', '/v1/settings/external-agents/codex');
  expect(res.status).toBe(200);
  const { agent } = (await res.json()) as { agent: ReturnType<typeof agentView> };
  expect(agent.name).toBe('codex');
  expect(agent.provider).toBe('codex');

  res = await call('GET', '/v1/settings/external-agents/does-not-exist');
  expect(res.status).toBe(404);

  await call('DELETE', '/v1/settings/external-agents/codex');
}

async function runNotFound(call: Call): Promise<void> {
  let res = await call('POST', '/v1/settings/external-agents/does-not-exist/enable');
  expect(res.status).toBe(404);

  res = await call('POST', '/v1/settings/external-agents/does-not-exist/disable');
  expect(res.status).toBe(404);

  res = await call('DELETE', '/v1/settings/external-agents/does-not-exist');
  expect(res.status).toBe(404);
}

async function runPresets(call: Call): Promise<void> {
  const res = await call('GET', '/v1/settings/external-agents/presets');
  expect(res.status).toBe(200);
  const { presets } = (await res.json()) as {
    presets: {
      id: string;
      command: string;
      defaultLaunchMode: string;
      settings?: Array<{ key: string; kind: string }>;
    }[];
  };
  const presetIds = presets.map((p) => p.id);
  for (const id of ['claude-code', 'codex', 'gemini', 'hermes', 'openclaw', 'qwen']) {
    expect(presetIds).toContain(id);
  }
  expect(presets.every((p) => p.defaultLaunchMode === 'pty')).toBe(true);
  expect(presets.find((p) => p.id === 'codex')?.command).toBe('codex');
  expect(presets.find((p) => p.id === 'gemini')?.command).toBe('gemini');
  expect(presets.find((p) => p.id === 'qwen')?.command).toBe('qwen');
  expect(presets.find((p) => p.id === 'openclaw')?.command).toBe('openclaw');
  expect(presets.find((p) => p.id === 'hermes')?.command).toBe('hermes');
  expect(presets.find((p) => p.id === 'codex')?.settings?.map((setting) => [setting.key, setting.kind])).toContainEqual(
    ['defaultLaunchMode', 'select']
  );
  expect(presets.find((p) => p.id === 'codex')?.settings?.map((setting) => [setting.key, setting.kind])).toContainEqual(
    ['allowAutopilot', 'switch']
  );
}

async function runValidation(call: Call, paths: MonadPaths): Promise<void> {
  let res = await call('PUT', '/v1/settings/external-agents/codex', {
    agent: { ...agentView(), command: '   ' }
  });
  expect(res.status).not.toBe(200);

  res = await call('PUT', '/v1/settings/external-agents/codex', {
    agent: { ...agentView(), command: 'codex;rm' }
  });
  expect(res.status).not.toBe(200);

  res = await call('PUT', '/v1/settings/external-agents/codex', {
    agent: { ...agentView(), env: { 'BAD KEY': 'value' } }
  });
  expect(res.status).not.toBe(200);

  res = await call('PUT', '/v1/settings/external-agents/codex', {
    agent: { ...agentView(), env: { GOOD_KEY: 'bad\u0000value' } }
  });
  expect(res.status).not.toBe(200);

  expect((await loadConfig(paths))?.externalAgents).toEqual([]);
}

for (const kind of TRANSPORTS) {
  describe(`external-agent-settings over ${kind}`, () => {
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

    test('invite presets list direct external agent providers', async () => {
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
