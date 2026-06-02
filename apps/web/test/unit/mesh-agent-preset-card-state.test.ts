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
  installed: false
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

test('Monad preset opens settings without exposing disconnect', () => {
  expect(meshAgentPresetCardState({ preset: monadPreset })).toEqual({
    isConnected: true,
    canDisconnect: false,
    settingsAgent: {
      name: 'monad',
      displayName: 'Monad',
      provider: 'monad',
      productIcon: 'monad',
      command: 'monad',
      args: [],
      modelOptions: undefined,
      modelOptionDisplayNames: undefined,
      reasoningEfforts: undefined,
      enabled: true,
      allowAutopilot: true,
      approvalOwnership: 'provider-owned',
      capabilities: undefined
    }
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
