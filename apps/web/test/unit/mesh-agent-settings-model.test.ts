import type { MeshAgentPresetView, MeshAgentView } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  canDisableAutopilot,
  meshAgentAppServerTransportOptions,
  meshAgentLaunchModeOptions,
  meshAgentSettingDescription,
  meshAgentSettings,
  normalizeMeshAgentLaunchMode
} from '../../src/features/studio/third-party-agents/mesh-agent-settings-model';

const agent: MeshAgentView = {
  name: 'codex',
  provider: 'codex',
  command: 'codex',
  args: [],
  enabled: true,
  defaultLaunchMode: 'app-server',
  allowAutopilot: true,
  approvalOwnership: 'provider-owned'
};

const preset: MeshAgentPresetView = {
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

test('MeshAgent settings hide PTY because it is auth-only for MeshAgents', () => {
  expect(meshAgentLaunchModeOptions(agent, preset)).toEqual(['app-server']);
});

test('MeshAgent settings preserve the current launch mode when preset metadata is unavailable', () => {
  expect(meshAgentLaunchModeOptions(agent, undefined)).toEqual(['app-server']);
});

test('MeshAgent settings normalize existing PTY launch mode to a non-PTY mode', () => {
  expect(normalizeMeshAgentLaunchMode('pty', ['pty', 'json-stream', 'app-server'])).toBe('json-stream');
  expect(normalizeMeshAgentLaunchMode('pty', ['pty'])).toBe('app-server');
});

test('MeshAgent settings app-server transports come from the agent preset capabilities', () => {
  expect(meshAgentAppServerTransportOptions(preset)).toEqual(['stdio', 'unix']);
});

test('MeshAgent settings cannot disable dangerous mode without an available approval proxy', () => {
  expect(canDisableAutopilot(agent)).toBe(false);
  expect(
    canDisableAutopilot({
      ...agent,
      capabilities: {
        auth: 'pty',
        events: 'paged',
        resume: 'structured',
        approval: 'provider-owned',
        approvalProxy: true
      }
    })
  ).toBe(true);
});

test('MeshAgent settings use preset approval proxy capabilities for existing agents', () => {
  expect(
    canDisableAutopilot(agent, {
      ...preset,
      capabilities: {
        auth: 'pty',
        events: 'paged',
        resume: 'structured',
        approval: 'provider-owned',
        approvalProxy: true
      }
    })
  ).toBe(true);
});

test('MeshAgent settings prefer adapter-declared controls from the preset', () => {
  expect(
    meshAgentSettings(agent, {
      ...preset,
      settings: [
        {
          key: 'defaultLaunchMode',
          label: 'Launch mode',
          kind: 'select',
          options: [
            { value: 'pty', label: 'PTY' },
            { value: 'app-server', label: 'App server' }
          ]
        },
        { key: 'allowAutopilot', label: 'Autopilot', kind: 'switch' }
      ]
    })
  ).toEqual([
    {
      key: 'defaultLaunchMode',
      label: 'Launch mode',
      kind: 'select',
      options: [{ value: 'app-server', label: 'App server' }]
    },
    { key: 'allowAutopilot', label: 'Autopilot', kind: 'switch' }
  ]);
});

test('MeshAgent autopilot description explains unavailable approval proxy before generic adapter copy', () => {
  expect(
    meshAgentSettingDescription(
      {
        key: 'allowAutopilot',
        label: 'Autopilot',
        description: 'Let the provider run unattended when supported.',
        kind: 'switch'
      },
      { canToggleAutopilot: false }
    )
  ).toBe('approvalProxyUnavailable');
});
