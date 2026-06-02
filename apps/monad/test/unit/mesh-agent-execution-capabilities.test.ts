import { expect, test } from 'bun:test';

import { codexMeshAgentAdapter } from '../../../../packages/atoms/src/agent-adapters/codex/index.ts';
import { openClawMeshAgentAdapter } from '../../../../packages/atoms/src/agent-adapters/openclaw/index.ts';
import { meshAgentSettingsForAdapter } from '../../src/services/mesh-agent/index.ts';

test('provider settings expose autopilot only when the adapter implements it', () => {
  expect({
    codex: meshAgentSettingsForAdapter(codexMeshAgentAdapter)?.map((setting) => setting.key),
    openclaw: meshAgentSettingsForAdapter(openClawMeshAgentAdapter)?.map((setting) => setting.key)
  }).toEqual({
    codex: ['allowAutopilot'],
    openclaw: []
  });
});
