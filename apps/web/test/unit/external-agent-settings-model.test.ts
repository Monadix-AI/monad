import type { ExternalAgentPresetView, ExternalAgentView } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  canDisableAutopilot,
  externalAgentAppServerTransportOptions,
  externalAgentLaunchModeOptions,
  externalAgentSettingDescription,
  externalAgentSettings,
  normalizeExternalAgentLaunchMode
} from '../../features/studio/third-party-agents/external-agent-settings-model';

const agent: ExternalAgentView = {
  name: 'codex',
  provider: 'codex',
  command: 'codex',
  args: [],
  enabled: true,
  defaultLaunchMode: 'app-server',
  allowAutopilot: true,
  approvalOwnership: 'provider-owned'
};

const preset: ExternalAgentPresetView = {
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

test('external agent settings hide PTY because it is auth-only for external agents', () => {
  expect(externalAgentLaunchModeOptions(agent, preset)).toEqual(['app-server']);
});

test('external agent settings preserve the current launch mode when preset metadata is unavailable', () => {
  expect(externalAgentLaunchModeOptions(agent, undefined)).toEqual(['app-server']);
});

test('external agent settings normalize existing PTY launch mode to a non-PTY mode', () => {
  expect(normalizeExternalAgentLaunchMode('pty', ['pty', 'json-stream', 'app-server'])).toBe('json-stream');
  expect(normalizeExternalAgentLaunchMode('pty', ['pty'])).toBe('app-server');
});

test('external agent settings app-server transports come from the agent preset capabilities', () => {
  expect(externalAgentAppServerTransportOptions(preset)).toEqual(['stdio', 'unix']);
});

test('external agent settings cannot disable dangerous mode without an available approval proxy', () => {
  expect(canDisableAutopilot(agent)).toBe(false);
  expect(
    canDisableAutopilot({
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

test('external agent settings use preset approval proxy capabilities for existing agents', () => {
  expect(
    canDisableAutopilot(agent, {
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

test('external agent settings prefer adapter-declared controls from the preset', () => {
  expect(
    externalAgentSettings(agent, {
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

test('external agent autopilot description explains unavailable approval proxy before generic adapter copy', () => {
  expect(
    externalAgentSettingDescription(
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
