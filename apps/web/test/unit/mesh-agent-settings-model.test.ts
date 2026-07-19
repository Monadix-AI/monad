import type { MeshAgentPresetView, MeshAgentView } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  canDisableAutopilot,
  meshAgentSettingDescription,
  meshAgentSettings
} from '../../src/features/studio/third-party-agents/mesh-agent-settings-model';

const agent: MeshAgentView = {
  name: 'codex',
  provider: 'codex',
  command: 'codex',
  args: [],
  enabled: true,
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
  installHint: 'Install Codex',
  installUrl: 'https://developers.openai.com/codex/cli',
  installed: true
};

test('MeshAgent settings expose only adapter-declared controls', () => {
  expect(
    meshAgentSettings(agent, {
      ...preset,
      settings: [{ key: 'allowAutopilot', label: 'Autopilot', kind: 'switch' }]
    })
  ).toEqual([{ key: 'allowAutopilot', label: 'Autopilot', kind: 'switch' }]);
});

test('MeshAgent settings fall back to Autopilot without runtime-topology controls', () => {
  expect(meshAgentSettings(agent, preset)).toEqual([{ key: 'allowAutopilot', label: 'Autopilot', kind: 'switch' }]);
});

test('MeshAgent settings use declared approval proxy capability', () => {
  expect(canDisableAutopilot(agent)).toBe(false);
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

test('MeshAgent autopilot description explains an unavailable approval proxy', () => {
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
