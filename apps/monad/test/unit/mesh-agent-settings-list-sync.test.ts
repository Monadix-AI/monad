import type { MonadConfig } from '@monad/environment';
import type { MeshAgentPresetView } from '@monad/protocol';

import { afterEach, expect, test } from 'bun:test';

import { openClawMeshAgentAdapter } from '../../../../packages/atoms/src/agent-adapters/openclaw/index.ts';
import { createMeshAgentSettingsModule } from '../../src/handlers/settings/mesh-agent/index.ts';
import { registerAgentAdapterImpl, unregisterAgentAdapterImpl } from '../../src/services/mesh-agent/index.ts';
import { waitFor } from '../wait.ts';

afterEach(() => unregisterAgentAdapterImpl('openclaw'));

test('listing MeshAgents returns persisted agents before provider discovery finishes', async () => {
  registerAgentAdapterImpl(openClawMeshAgentAdapter);
  let cfg = {
    meshAgents: [
      {
        name: 'openclaw',
        provider: 'openclaw',
        command: 'openclaw',
        enabled: true,
        allowAutopilot: false,
        approvalOwnership: 'provider-owned'
      }
    ]
  } as unknown as MonadConfig;
  let commits = 0;
  let finishDiscovery: (() => void) | undefined;
  const discoveryStarted = new Promise<void>((resolve) => {
    finishDiscovery = resolve;
  });
  const module = createMeshAgentSettingsModule({
    config: {
      get: () => ({ cfg, auth: null }),
      updateConfig: async (
        mutate: (value: MonadConfig) => MonadConfig | undefined | Promise<MonadConfig | undefined>
      ) => {
        cfg = (await mutate(structuredClone(cfg))) ?? cfg;
        commits++;
        return { cfg, auth: null };
      }
    } as never,
    syncDiscoveredAgents: async (input) => {
      await discoveryStarted;
      return {
        cfg: {
          ...input,
          meshAgents: [
            ...input.meshAgents,
            {
              name: 'openclaw--test',
              displayName: 'test',
              provider: 'openclaw',
              command: 'openclaw',
              enabled: true,
              allowAutopilot: false,
              approvalOwnership: 'provider-owned',
              discovery: { connectorName: 'openclaw', externalId: 'test', state: 'available' }
            }
          ]
        },
        changed: true
      };
    }
  });

  const result = await module.listMeshAgents();

  expect(commits).toBe(0);
  expect(result.agents.map((agent) => agent.name)).toEqual(['openclaw']);

  finishDiscovery?.();
  await waitFor(() => commits === 1, { message: 'discovery result was never committed' });

  expect(cfg.meshAgents).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'openclaw--test', displayName: 'test' })])
  );
});

test('listing MeshAgents keeps capability probes off the read path and shares one background refresh', async () => {
  const capabilityLaunch = { argv: ['mesh-agent-probe'], cwd: '/tmp' };
  registerAgentAdapterImpl({
    ...openClawMeshAgentAdapter,
    resolveCommand: (command) => command,
    listSupportedModels: () => [],
    modelOptions: () => ({
      launch: capabilityLaunch,
      parse: () => [{ value: 'probe-model', displayName: 'Probe Model', speeds: ['fast'] }]
    }),
    argumentSupport: () => ({
      launch: capabilityLaunch,
      parse: () => ({
        flags: ['--model'],
        reasoningEfforts: ['high'],
        speeds: [],
        reasoningEffortsByModel: { 'probe-model': ['high'] }
      })
    }),
    settings: undefined
  });
  const cfg = {
    agent: { agents: [] },
    meshAgents: [
      {
        name: 'openclaw-a',
        provider: 'openclaw',
        command: 'openclaw',
        enabled: true,
        allowAutopilot: false,
        approvalOwnership: 'provider-owned'
      },
      {
        name: 'openclaw-b',
        provider: 'openclaw',
        command: 'openclaw',
        enabled: true,
        allowAutopilot: false,
        approvalOwnership: 'provider-owned'
      }
    ]
  } as unknown as MonadConfig;
  let probeRuns = 0;
  let finishProbe: (() => void) | undefined;
  const probePending = new Promise<void>((resolve) => {
    finishProbe = resolve;
  });
  const module = createMeshAgentSettingsModule({
    config: { get: () => ({ cfg, auth: null }) } as never,
    syncDiscoveredAgents: async (input) => ({ cfg: input, changed: false }),
    probeRunner: async () => {
      probeRuns++;
      await probePending;
      return { stdout: '', stderr: '', exitCode: 0 };
    }
  });

  const [first, second] = await Promise.all([module.listMeshAgents(), module.listMeshAgents()]);

  expect(probeRuns).toBe(1);
  expect(first).toEqual({
    agents: cfg.meshAgents.map((agent) => ({
      ...agent,
      productIcon: 'openclaw',
      args: undefined,
      displayName: undefined,
      env: undefined,
      capabilities: {
        auth: 'pty',
        events: 'provider-owned',
        resume: 'pty',
        approval: 'provider-owned',
        autopilot: false,
        fastMode: false,
        settingsImport: true,
        approvalProxy: true
      },
      adapterSettings: undefined,
      discovery: undefined,
      modelOptions: [],
      reasoningEfforts: [],
      settings: undefined
    }))
  });
  expect(second).toEqual(first);

  finishProbe?.();
  await waitFor(
    async () => (await module.listMeshAgents()).agents.some((agent) => (agent.modelOptions?.length ?? 0) > 0),
    {
      message: 'probe result never reached the agent list'
    }
  );

  expect(await module.listMeshAgents()).toEqual({
    agents: cfg.meshAgents.map((agent) => ({
      ...agent,
      productIcon: 'openclaw',
      args: undefined,
      displayName: undefined,
      env: undefined,
      capabilities: {
        auth: 'pty',
        events: 'provider-owned',
        resume: 'pty',
        approval: 'provider-owned',
        autopilot: false,
        fastMode: false,
        settingsImport: true,
        approvalProxy: true
      },
      adapterSettings: undefined,
      discovery: undefined,
      modelOptions: ['probe-model'],
      modelOptionDisplayNames: { 'probe-model': 'Probe Model' },
      speedsByModel: { 'probe-model': ['fast'] },
      reasoningEfforts: ['high'],
      reasoningEffortsByModel: { 'probe-model': ['high'] },
      settings: undefined
    }))
  });
});

test('listing invitable MeshAgents returns fallback capabilities while refreshing the cache', async () => {
  const capabilityLaunch = { argv: ['mesh-agent-probe'], cwd: '/tmp' };
  registerAgentAdapterImpl({
    ...openClawMeshAgentAdapter,
    resolveCommand: (command) => command,
    modelOptions: () => ({
      launch: capabilityLaunch,
      parse: () => [{ value: 'probe-model', displayName: 'Probe Model', speeds: ['fast'] }]
    }),
    argumentSupport: undefined,
    settings: undefined
  });
  const cfg = {
    agent: { agents: [] },
    meshAgents: [
      {
        name: 'openclaw',
        provider: 'openclaw',
        command: 'openclaw',
        enabled: true,
        allowAutopilot: false,
        approvalOwnership: 'provider-owned'
      }
    ]
  } as unknown as MonadConfig;
  let finishProbe: (() => void) | undefined;
  const updates: string[][] = [];
  const probePending = new Promise<void>((resolve) => {
    finishProbe = resolve;
  });
  const module = createMeshAgentSettingsModule({
    config: { get: () => ({ cfg, auth: null }) } as never,
    syncDiscoveredAgents: async (input) => ({ cfg: input, changed: false }),
    onCatalogUpdated: (resources) => updates.push(resources),
    probeRunner: async () => {
      await probePending;
      return { stdout: '', stderr: '', exitCode: 0 };
    }
  });

  const initial = await module.listInvitableMeshAgents();

  expect(
    initial.agents
      .filter((agent) => agent.name === 'openclaw')
      .map((agent) => ({ icon: agent.icon, modelOptions: agent.modelOptions, speedsByModel: agent.speedsByModel }))
  ).toEqual([{ icon: openClawMeshAgentAdapter.icon, modelOptions: [], speedsByModel: undefined }]);

  finishProbe?.();
  await waitFor(() => updates.length === 1, { message: 'capability refresh did not notify subscribers' });
  const refreshed = await module.listInvitableMeshAgents();

  expect(
    refreshed.agents
      .filter((agent) => agent.name === 'openclaw')
      .map((agent) => ({ modelOptions: agent.modelOptions, speedsByModel: agent.speedsByModel }))
  ).toEqual([{ modelOptions: ['probe-model'], speedsByModel: { 'probe-model': ['fast'] } }]);
  expect(updates).toEqual([['agents', 'invitable-agents']]);
});

test('preset requests return the cache while one background refresh updates and notifies it', async () => {
  const fallback = [{ id: 'cached', modelOptions: ['cached-model'] }] as MeshAgentPresetView[];
  const refreshed = [{ id: 'cached', modelOptions: ['fresh-model'] }] as MeshAgentPresetView[];
  let finishRefresh: (() => void) | undefined;
  let runs = 0;
  const firstRefresh = new Promise<void>((resolve) => {
    finishRefresh = resolve;
  });
  const updates: string[][] = [];
  const cfg = { agent: { agents: [] }, meshAgents: [] } as unknown as MonadConfig;
  const module = createMeshAgentSettingsModule({
    config: { get: () => ({ cfg, auth: null }) } as never,
    listPresets: async () => {
      runs++;
      if (runs === 1) await firstRefresh;
      return refreshed;
    },
    onCatalogUpdated: (resources) => updates.push(resources),
    presetFallbacks: () => fallback,
    syncDiscoveredAgents: async (input) => ({ cfg: input, changed: false })
  });

  const first = await module.listMeshAgentPresets();
  const second = await module.listMeshAgentPresets();

  expect({ first, second, runs }).toEqual({
    first: { presets: fallback },
    second: { presets: fallback },
    runs: 1
  });

  finishRefresh?.();
  await waitFor(() => updates.some((resources) => resources.includes('presets')), {
    message: 'preset refresh did not notify subscribers'
  });

  expect(await module.listMeshAgentPresets()).toEqual({ presets: refreshed });
  expect(updates.filter((resources) => resources.includes('presets'))).toEqual([['presets']]);

  expect(await module.refreshCatalog()).toEqual({ ok: true });
  expect(runs).toBe(2);
  expect(updates.filter((resources) => resources.includes('presets'))).toEqual([['presets']]);
});
