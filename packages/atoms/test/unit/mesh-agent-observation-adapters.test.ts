import { expect, test } from 'bun:test';

// Import the composition-root setup directly — NOT the atoms barrel — to prove it alone configures the
// client resolver. Without it, a web/TUI host renders structured provider output as raw JSON.
import { configureBuiltinMeshAgentObservationAdapters } from '../../src/mesh-agent-observation-setup.ts';
import { meshAgentStreamItems } from '../../src/workspace-experiences/experience/mesh-agent-observation/mesh-agent-observation.ts';

configureBuiltinMeshAgentObservationAdapters();

test('registry resolves the claude-code adapter so a result parses to a card, not raw JSON', () => {
  const output = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Both agents are now engaged and standing by.'
  });
  const [item] = meshAgentStreamItems({ id: 'mesh_x00000000000', provider: 'claude-code', output });

  expect(item?.providerEventType).toBe('result');
  expect(item?.text).toBe('Both agents are now engaged and standing by.');
});

test('registry resolves codex/gemini/qwen provider output structurally', () => {
  const codex = meshAgentStreamItems({
    id: 'mesh_c00000000000',
    provider: 'codex',
    output: '{"method":"item/reasoning/textDelta","params":{"delta":"Inspecting."}}'
  });
  expect(codex.some((item) => item.providerEventType !== 'raw_json')).toBe(true);
});
