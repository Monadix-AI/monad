import type { ExternalAgentProviderAdapter } from '#/services/external-agent/types.ts';

import { expect, test } from 'bun:test';

import {
  listExternalAgentPresets,
  registerAgentAdapterImpl,
  unregisterAgentAdapterImpl
} from '#/services/external-agent/index.ts';

const provider = 'async-probe-test';
const probeLaunch = {
  argv: ['probe-tool', '--help'],
  cwd: '/tmp',
  launchMode: 'pty' as const,
  provider,
  approvalOwnership: 'provider-owned' as const,
  capabilities: []
};

function adapter(options: { throwInModelParser?: boolean } = {}): ExternalAgentProviderAdapter {
  return {
    provider,
    productIcon: provider,
    label: 'Async Probe Test',
    detect: () => ({
      id: provider,
      label: 'Async Probe Test',
      provider,
      productIcon: provider,
      command: 'probe-tool',
      args: [],
      defaultLaunchMode: 'pty',
      supportedLaunchModes: ['pty'],
      installHint: 'Install probe-tool',
      installUrl: 'https://example.com/probe-tool',
      installed: true,
      capabilities: {
        auth: 'none',
        history: 'none',
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
    buildLaunch: () => probeLaunch,
    buildAuthLaunch: () => probeLaunch,
    buildAuthStatusLaunch: () => probeLaunch,
    authStatus: () => ({ launch: probeLaunch, parse: () => 'unknown' }),
    parseAuthStatus: () => 'unknown',
    parseOutput: () => [],
    sendInput: () => {},
    resize: () => {},
    stop: () => {}
  };
}

const probes = { which: () => '/bin/probe-tool', exists: () => true };

function expectedPreset(options: { modelsLive: boolean; supportLive: boolean }) {
  return {
    id: provider,
    label: 'Async Probe Test',
    provider,
    productIcon: provider,
    command: 'probe-tool',
    args: [],
    defaultLaunchMode: 'pty',
    supportedLaunchModes: ['pty'],
    installHint: 'Install probe-tool',
    installUrl: 'https://example.com/probe-tool',
    installed: true,
    capabilities: {
      auth: 'none',
      history: 'none',
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

test('deduplicates equal probes per request and executes a fresh batch on the next request', async () => {
  registerAgentAdapterImpl(adapter());
  const launches: string[][] = [];
  try {
    const runner = async (launch: { argv: string[] }) => {
      launches.push(launch.argv);
      return { stdout: 'valid', stderr: '', exitCode: 0 };
    };

    const first = await listExternalAgentPresets(probes, runner);
    const second = await listExternalAgentPresets(probes, runner);

    expect(first).toEqual([expectedPreset({ modelsLive: true, supportLive: true })]);
    expect(second).toEqual([expectedPreset({ modelsLive: true, supportLive: true })]);
    expect(launches).toEqual([
      ['/bin/probe-tool', '--help'],
      ['/bin/probe-tool', '--help']
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
      const presets = await listExternalAgentPresets(probes, item.runner);
      expect(presets).toEqual([item.expected]);
    } finally {
      unregisterAgentAdapterImpl(provider);
    }
  }
});
