import type { MonadPaths } from '@monad/home';
import type { NativeCliProviderAdapter } from '@monad/sdk-atom';

import { describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome, loadAll, loadAuth, loadConfig } from '@monad/home';

import { ModelService } from '@/handlers/settings/model/index.ts';
import { registerAgentAdapterImpl } from '@/services/native-cli/index.ts';
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
  modelOptions: ['gpt-5.5', 'custom-codex'],
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
  enabled: true,
  defaultLaunchMode: 'pty',
  allowDangerousMode: false,
  approvalOwnership: 'provider-owned'
});

const THIRD_PARTY_IMPORT_PATH = join(tmpdir(), 'monad-third-party-migrator-settings');

const thirdPartyMigrationAdapter: NativeCliProviderAdapter = {
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
          id: 'nativeCliAgents:third-party-migrator',
          hash: 'third-party-hash',
          category: 'nativeCliAgents',
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
            allowDangerousMode: false,
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
  expect(agents[0]?.modelOptions).toEqual(['gpt-5.5', 'custom-codex']);
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

  expect((await loadConfig(paths.config))?.nativeCliAgents).toHaveLength(1);
  expect((await loadConfig(paths.config))?.nativeCliAgents[0]?.modelOptions).toEqual(['gpt-5.5', 'custom-codex']);
  expect((await loadConfig(paths.config))?.nativeCliAgents[0]?.projectTemplates?.[0]?.displayName).toBe('Reviewer');
  const loaded = await loadAll(paths.config, paths.profile);
  expect(loaded?.nativeCliAgents).toHaveLength(1);
  expect(loaded?.nativeCliAgents[0]?.projectTemplates?.[0]?.customPrompt).toBe('Review changes only.');

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

async function runSettingsImport(call: Call, paths: MonadPaths, dir: string): Promise<void> {
  const codexHome = join(dir, '.codex');
  const workspaceCodex = join(dir, 'project', '.codex');
  await mkdir(codexHome, { recursive: true });
  await mkdir(workspaceCodex, { recursive: true });
  await Bun.write(join(codexHome, 'config.toml'), 'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n');
  await Bun.write(join(workspaceCodex, 'config.toml'), 'model = "gpt-5.6-workspace"\n');

  let res = await call('GET', '/v1/settings/native-cli-agents/codex/import/candidates');
  expect(res.status).toBe(200);
  const candidatesBody = (await res.json()) as { candidates: Array<{ provider: string; path: string }> };
  expect(candidatesBody.candidates.every((candidate) => candidate.provider === 'codex')).toBe(true);

  res = await call('POST', '/v1/settings/native-cli-agents/codex/import/preview', { path: codexHome });
  expect(res.status).toBe(200);
  const preview = (await res.json()) as {
    items: Array<{ id: string; hash: string; category: string; target: string; action: string }>;
  };
  const agentItem = preview.items.find((item) => item.category === 'nativeCliAgents' && item.target === 'codex');
  expect(agentItem?.action).toBe('add');
  if (!agentItem) throw new Error('expected codex native CLI import item');

  res = await call('POST', '/v1/settings/native-cli-agents/codex/import/apply', {
    path: codexHome,
    select: [agentItem.id],
    hashes: { [agentItem.id]: 'stale' },
    replace: false
  });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { applied: string[] }).applied).toEqual([]);

  res = await call('POST', '/v1/settings/native-cli-agents/codex/import/apply', {
    path: codexHome,
    select: [agentItem.id],
    hashes: { [agentItem.id]: agentItem.hash },
    replace: false
  });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { applied: string[] }).applied).toContain(agentItem.id);

  const saved = await loadConfig(paths.config);
  expect(saved?.nativeCliAgents.find((agent) => agent.name === 'codex')).toMatchObject({
    provider: 'codex',
    command: 'codex',
    modelOptions: ['gpt-5.5']
  });

  res = await call('POST', '/v1/settings/native-cli-agents/codex/import/preview', {
    sources: [
      { path: codexHome, scope: 'global' },
      { path: workspaceCodex, scope: 'workspace' }
    ]
  });
  expect(res.status).toBe(200);
  const mergedPreview = (await res.json()) as {
    items: Array<{ id: string; hash: string; category: string; target: string; action: string }>;
  };
  const workspaceItem = mergedPreview.items.find((item) => item.target === 'codex-workspace');
  expect(workspaceItem?.action).toBe('add');
  if (!workspaceItem) throw new Error('expected workspace codex native CLI import item');

  res = await call('POST', '/v1/settings/native-cli-agents/codex/import/apply', {
    sources: [
      { path: codexHome, scope: 'global' },
      { path: workspaceCodex, scope: 'workspace' }
    ],
    select: [workspaceItem.id],
    hashes: { [workspaceItem.id]: workspaceItem.hash },
    replace: false
  });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { applied: string[] }).applied).toContain(workspaceItem.id);

  expect(
    (await loadConfig(paths.config))?.nativeCliAgents.find((agent) => agent.name === 'codex-workspace')
  ).toMatchObject({
    provider: 'codex',
    command: 'codex',
    modelOptions: ['gpt-5.6-workspace']
  });
}

async function runThirdPartyAdapterContractImport(call: Call, paths: MonadPaths): Promise<void> {
  await mkdir(THIRD_PARTY_IMPORT_PATH, { recursive: true });
  let res = await call('GET', '/v1/settings/native-cli-agents/third-party-migrator/import/candidates');
  expect(res.status).toBe(200);
  const candidates = (await res.json()) as {
    candidates: Array<{ provider: string; label: string; path: string; source: string; scope: string }>;
  };
  expect(candidates.candidates).toContainEqual({
    provider: 'third-party-migrator',
    label: 'Third Party Migrator',
    path: THIRD_PARTY_IMPORT_PATH,
    source: 'default',
    scope: 'global'
  });

  res = await call('POST', '/v1/settings/native-cli-agents/third-party-migrator/import/preview', {
    path: THIRD_PARTY_IMPORT_PATH
  });
  expect(res.status).toBe(200);
  const preview = (await res.json()) as {
    items: Array<{ id: string; hash: string; category: string; target: string; action: string }>;
  };
  const item = preview.items.find((entry) => entry.target === 'third-party-migrator');
  expect(item?.category).toBe('nativeCliAgents');
  if (!item) throw new Error('expected third-party native CLI import item');

  res = await call('POST', '/v1/settings/native-cli-agents/third-party-migrator/import/apply', {
    path: THIRD_PARTY_IMPORT_PATH,
    select: [item.id],
    hashes: { [item.id]: item.hash },
    replace: false
  });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { applied: string[] }).applied).toContain(item.id);

  expect(
    (await loadConfig(paths.config))?.nativeCliAgents.find((agent) => agent.name === 'third-party-migrator')
  ).toMatchObject({
    provider: 'third-party-migrator',
    command: 'third-party',
    args: ['--profile', 'default']
  });
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

    test('imports provider settings through the native CLI agent adapter contract', async () => {
      const { dir, paths, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runSettingsImport((m, p, b) => t.fetch(p, jsonInit(m, b)), paths, dir);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('imports third-party adapter settings through the same migration contract', async () => {
      const { dir, paths, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runThirdPartyAdapterContractImport((m, p, b) => t.fetch(p, jsonInit(m, b)), paths);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
}
