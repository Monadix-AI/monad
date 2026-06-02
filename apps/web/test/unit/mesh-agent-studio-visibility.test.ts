import type { MeshAgentPresetView, MeshAgentView } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  studioVisibleMeshAgentPresets,
  studioVisibleMeshAgents
} from '../../src/features/studio/third-party-agents/mesh-agent-studio-visibility';

const monadAgent: MeshAgentView = {
  name: 'monad--agt_000000000000',
  displayName: 'Reviewer',
  provider: 'monad',
  productIcon: 'monad',
  command: 'monad',
  enabled: true,
  allowAutopilot: true,
  approvalOwnership: 'provider-owned'
};

const monadConnector: MeshAgentView = {
  ...monadAgent,
  name: 'monad',
  displayName: 'Monad'
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

const monadPreset: MeshAgentPresetView = {
  id: 'monad',
  label: 'Monad',
  provider: 'monad',
  productIcon: 'monad',
  command: 'monad',
  args: [],
  installHint: '',
  installUrl: 'https://monad.local',
  installed: true
};

const codexPreset: MeshAgentPresetView = {
  id: 'codex',
  label: 'Codex',
  provider: 'codex',
  productIcon: 'codex',
  command: 'codex',
  args: [],
  installHint: '',
  installUrl: 'https://developers.openai.com/codex/cli',
  installed: true
};

test('Studio exposes the Monad connector card while hiding its discovered agents', () => {
  const agents = [monadConnector, monadAgent, codexAgent];
  const presets = [monadPreset, codexPreset];

  expect({
    visibleAgents: studioVisibleMeshAgents(agents),
    visiblePresets: studioVisibleMeshAgentPresets(presets),
    sourceAgents: agents,
    sourcePresets: presets
  }).toEqual({
    visibleAgents: [monadConnector, codexAgent],
    visiblePresets: [monadPreset, codexPreset],
    sourceAgents: [monadConnector, monadAgent, codexAgent],
    sourcePresets: [monadPreset, codexPreset]
  });
});
