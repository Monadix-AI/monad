import type { MeshAgentPresetView, MeshAgentView } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { meshAgentPresetCardState } from '../../src/features/studio/third-party-agents/mesh-agent-settings-utils';

const monadPreset: MeshAgentPresetView = {
  id: 'monad',
  label: 'Monad',
  provider: 'monad',
  productIcon: 'monad',
  command: 'monad',
  args: [],
  installHint: '',
  installUrl: 'https://monad.co',
  installed: true
};

const codexAgent: MeshAgentView = {
  name: 'codex',
  provider: 'codex',
  productIcon: 'codex',
  command: 'codex',
  enabled: true,
  allowAutopilot: true,
  approvalOwnership: 'provider-owned'
};

test('detected local Monad preset stays connectable until its connector is configured', () => {
  expect(meshAgentPresetCardState({ preset: monadPreset })).toEqual({
    isConnected: false,
    canDisconnect: false,
    settingsAgent: undefined
  });
});

test('connected Monad connector opens settings without exposing disconnect', () => {
  const monadConnector: MeshAgentView = {
    name: 'monad',
    displayName: 'Monad',
    provider: 'monad',
    productIcon: 'monad',
    command: 'monad',
    enabled: true,
    allowAutopilot: true,
    approvalOwnership: 'provider-owned'
  };

  expect(
    meshAgentPresetCardState({ preset: monadPreset, connectedAgent: monadConnector, statusAuth: 'authenticated' })
  ).toEqual({
    isConnected: true,
    canDisconnect: false,
    settingsAgent: monadConnector
  });
});

test('Connected external preset keeps disconnect and settings actions', () => {
  const preset: MeshAgentPresetView = {
    ...monadPreset,
    id: 'codex',
    label: 'Codex',
    provider: 'codex',
    productIcon: 'codex',
    command: 'codex',
    installed: true
  };

  expect(meshAgentPresetCardState({ preset, connectedAgent: codexAgent, statusAuth: 'authenticated' })).toEqual({
    isConnected: true,
    canDisconnect: true,
    settingsAgent: codexAgent
  });
});
