import { expect, test } from 'bun:test';

// Import the composition-root setup directly — NOT the atoms barrel — to prove it alone configures the
// client resolver. Without it, a web/TUI host renders structured provider output as raw JSON.
import { configureBuiltinNativeCliObservationAdapters } from '../../src/native-cli-observation-setup.ts';
import { nativeCliStreamItems } from '../../src/workspace-experiences/experience/native-cli-observation/native-cli-observation.ts';

configureBuiltinNativeCliObservationAdapters();

test('registry resolves the claude-code adapter so a result parses to a card, not raw JSON', () => {
  const output = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Both agents are now engaged and standing by.'
  });
  const [item] = nativeCliStreamItems({ id: 'ncli_x', provider: 'claude-code', output });

  expect(item?.providerEventType).toBe('result');
  expect(item?.text).toBe('Both agents are now engaged and standing by.');
});

test('registry resolves codex/gemini/qwen provider output structurally', () => {
  const codex = nativeCliStreamItems({
    id: 'ncli_c',
    provider: 'codex',
    output: '{"method":"item/reasoning/textDelta","params":{"delta":"Inspecting."}}'
  });
  expect(codex.some((item) => item.providerEventType !== 'raw_json')).toBe(true);
});
