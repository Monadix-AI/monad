import type { NativeCliAgentPresetView, NativeCliAgentView } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  canDisableDangerousMode,
  nativeCliAppServerTransportOptions,
  nativeCliLaunchModeOptions
} from '../../features/studio/third-party-agents/native-cli-agent-settings-model';

const agent: NativeCliAgentView = {
  name: 'codex',
  provider: 'codex',
  command: 'codex',
  args: [],
  enabled: true,
  defaultLaunchMode: 'app-server',
  allowDangerousMode: true,
  approvalOwnership: 'provider-owned'
};

const preset: NativeCliAgentPresetView = {
  id: 'codex',
  label: 'Codex',
  provider: 'codex',
  productIcon: 'codex',
  command: 'codex',
  args: [],
  defaultLaunchMode: 'pty',
  supportedLaunchModes: ['pty', 'app-server'],
  supportedAppServerTransports: ['stdio', 'unix'],
  installHint: 'Install Codex',
  installUrl: 'https://developers.openai.com/codex/cli',
  installed: true
};

test('native CLI settings launch mode options come from the agent preset capabilities', () => {
  expect(nativeCliLaunchModeOptions(agent, preset)).toEqual(['pty', 'app-server']);
});

test('native CLI settings preserve the current launch mode when preset metadata is unavailable', () => {
  expect(nativeCliLaunchModeOptions(agent, undefined)).toEqual(['app-server']);
});

test('native CLI settings app-server transports come from the agent preset capabilities', () => {
  expect(nativeCliAppServerTransportOptions(preset)).toEqual(['stdio', 'unix']);
});

test('native CLI settings cannot disable dangerous mode without an available approval proxy', () => {
  expect(canDisableDangerousMode(agent)).toBe(false);
  expect(
    canDisableDangerousMode({
      ...agent,
      capabilities: {
        auth: 'pty',
        history: 'paged',
        resume: 'structured',
        approval: 'provider-owned',
        approvalProxy: true
      }
    })
  ).toBe(true);
});

test('native CLI settings use preset approval proxy capabilities for existing agents', () => {
  expect(
    canDisableDangerousMode(agent, {
      ...preset,
      capabilities: {
        auth: 'pty',
        history: 'paged',
        resume: 'structured',
        approval: 'provider-owned',
        approvalProxy: true
      }
    })
  ).toBe(true);
});
