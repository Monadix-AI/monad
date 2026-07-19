import { expect, test } from 'bun:test';
import '../../src/index.ts';

import { meshAgentNeutralStreamItems } from '../../src/workspace-experiences/experience/mesh-agent-observation/mesh-agent-observation.ts';

test('projects a codex turn into neutral events: assistant-message + a completed turn-end', () => {
  const events = meshAgentNeutralStreamItems({
    id: 'c',
    provider: 'codex',
    output: [
      '{"method":"turn/started","params":{"turn":{}}}',
      '{"method":"item/agentMessage/delta","params":{"delta":"working"}}',
      '{"method":"turn/completed","params":{"turn":{}}}'
    ].join('\n')
  });
  const kinds = events.map((event) => event.kind);
  expect(kinds).toContain('assistant-message');
  expect(kinds).toContain('turn-end');
  expect(events.find((event) => event.kind === 'turn-end')?.reason).toBe('completed');
  // every neutral event is a valid member of the kind set (no legacy role/providerEventType leaks)
  for (const event of events) expect(event).not.toHaveProperty('role');
});

test('a claude error result projects a turn-end with reason error', () => {
  const events = meshAgentNeutralStreamItems({
    id: 'c',
    provider: 'claude-code',
    output: [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'oops' }] } }),
      JSON.stringify({ type: 'result', subtype: 'error', is_error: true })
    ].join('\n')
  });
  expect(events.find((event) => event.kind === 'turn-end')?.reason).toBe('error');
});

test('plain-text output with no adapter projects to assistant-message', () => {
  const events = meshAgentNeutralStreamItems({ id: 'c', output: 'just some text' });
  expect(events.map((event) => event.kind)).toEqual(['assistant-message']);
  expect(events[0]?.text).toBe('just some text');
});
