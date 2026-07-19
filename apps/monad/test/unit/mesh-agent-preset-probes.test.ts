import type { MeshAgentPresetView } from '@monad/protocol';
import type { MeshAgentProviderAdapter } from '#/services/mesh-agent/types.ts';

import { expect, test } from 'bun:test';

import {
  listMeshAgentPresets,
  registerAgentAdapterImpl,
  unregisterAgentAdapterImpl
} from '#/services/mesh-agent/index.ts';

const provider = 'async-probe-test';
const probeLaunch = {
  argv: ['probe-tool', '--help'],
  cwd: '/tmp'
};

function adapter(options: { throwInModelParser?: boolean } = {}): MeshAgentProviderAdapter {
  return {
    provider,
    productIcon: provider,
    label: 'Async Probe Test',
    events: { projectLive: () => ({ events: [] }) },
    detect: () => ({
      id: provider,
      label: 'Async Probe Test',
      provider,
      productIcon: provider,
      command: 'probe-tool',
      args: [],
      installHint: 'Install probe-tool',
      installUrl: 'https://example.com/probe-tool',
      installed: true,
      capabilities: {
        auth: 'none',
        events: 'none',
        resume: 'pty',
        approval: 'provider-owned'
      }
    }),
    resolveCommand: () => '/bin/probe-tool',
    listSupportedModels: () => ['fallback-model'],
    modelOptions: () => ({
      launch: probeLaunch,
      parse: (output) => {
        if (options.throwInModelParser) throw new Error('bad model output');
        return output.includes('valid') ? [{ value: 'live-model', displayName: 'Live Model' }] : [];
      }
    }),
    argumentSupport: () => ({
      launch: probeLaunch,
      parse: (output) => ({
        flags: output.includes('valid') ? ['--reasoning-effort'] : [],
        reasoningEfforts: output.includes('valid') ? ['high'] : [],
        reasoningEffortsByModel: output.includes('valid') ? { 'live-model': ['high'] } : undefined,
        speeds: []
      })
    }),
    buildAuthLaunch: () => probeLaunch,
    buildAuthStatusLaunch: () => probeLaunch,
    authStatus: () => ({ launch: probeLaunch, parse: () => 'unknown' }),
    parseAuthStatus: () => 'unknown'
  };
}

const probes = { which: () => '/bin/probe-tool', exists: () => true };

type ProjectedPreset = MeshAgentPresetView & {
  reasoningEffortsByModel?: Record<string, string[]>;
};

function expectedPreset(options: { modelsLive: boolean; supportLive: boolean }): ProjectedPreset {
  return {
    id: provider,
    label: 'Async Probe Test',
    provider,
    productIcon: provider,
    command: 'probe-tool',
    args: [],
    installHint: 'Install probe-tool',
    installUrl: 'https://example.com/probe-tool',
    installed: true,
    capabilities: {
      auth: 'none',
      events: 'none',
      resume: 'pty',
      approval: 'provider-owned'
    },
    settings: undefined,
    modelOptions: options.modelsLive ? ['live-model'] : ['fallback-model'],
    ...(options.modelsLive ? { modelOptionDisplayNames: { 'live-model': 'Live Model' } } : {}),
    reasoningEfforts: options.supportLive ? ['high'] : [],
    reasoningEffortsByModel: options.supportLive ? { 'live-model': ['high'] } : undefined
  };
}

function testPresets(presets: MeshAgentPresetView[]): MeshAgentPresetView[] {
  return presets.filter((preset) => preset.id === provider);
}

test('deduplicates equal probes per request and executes a fresh batch on the next request', async () => {
  registerAgentAdapterImpl(adapter());
  const launches: Array<{ argv: string[]; cwd: string }> = [];
  try {
    const runner = async (launch: { argv: string[]; cwd: string }) => {
      if (launch.cwd === '/tmp') launches.push({ argv: launch.argv, cwd: launch.cwd });
      return { stdout: 'valid', stderr: '', exitCode: 0 };
    };

    const first = await listMeshAgentPresets(probes, runner);
    const second = await listMeshAgentPresets(probes, runner);

    expect(testPresets(first)).toEqual([expectedPreset({ modelsLive: true, supportLive: true })]);
    expect(testPresets(second)).toEqual([expectedPreset({ modelsLive: true, supportLive: true })]);
    expect(launches).toEqual([
      { argv: ['/bin/probe-tool', '--help'], cwd: '/tmp' },
      { argv: ['/bin/probe-tool', '--help'], cwd: '/tmp' }
    ]);
  } finally {
    unregisterAgentAdapterImpl(provider);
  }
});

test('uses exact static fallbacks when execution or parsing fails', async () => {
  const cases = [
    {
      configured: adapter(),
      runner: async () => Promise.reject(new Error('launch failed')),
      expected: expectedPreset({ modelsLive: false, supportLive: false })
    },
    {
      configured: adapter(),
      runner: async () => ({ stdout: 'valid', stderr: '', exitCode: null }),
      expected: expectedPreset({ modelsLive: false, supportLive: false })
    },
    {
      configured: adapter(),
      runner: async () => ({ stdout: 'valid', stderr: '', exitCode: 1 }),
      expected: expectedPreset({ modelsLive: false, supportLive: false })
    },
    {
      configured: adapter({ throwInModelParser: true }),
      runner: async () => ({ stdout: 'valid', stderr: '', exitCode: 0 }),
      expected: expectedPreset({ modelsLive: false, supportLive: true })
    }
  ];

  for (const item of cases) {
    registerAgentAdapterImpl(item.configured);
    try {
      const presets = await listMeshAgentPresets(probes, item.runner);
      expect(testPresets(presets)).toEqual([item.expected]);
    } finally {
      unregisterAgentAdapterImpl(provider);
    }
  }
});
