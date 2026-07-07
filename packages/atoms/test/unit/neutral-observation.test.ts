import type { ExternalAgentObservationEvent } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { toAgentObservationEvent } from '../../src/agent-adapters/neutral-observation.ts';

const event = (over: Partial<ExternalAgentObservationEvent>): ExternalAgentObservationEvent => ({
  id: 'e',
  role: 'agent',
  text: 't',
  source: 'codex-app-server',
  ...over
});

test('a streaming assistant delta becomes a streaming assistant-message carrying its text', () => {
  const neutral = toAgentObservationEvent(event({ providerEventType: 'item/agentMessage/delta', text: 'hel' }));
  expect(neutral).toMatchObject({ kind: 'assistant-message', streaming: true, text: 'hel' });
});

test('a reasoning delta maps to the reasoning kind', () => {
  expect(toAgentObservationEvent(event({ providerEventType: 'item/reasoning/textDelta' }))?.kind).toBe('reasoning');
});

test('a user record maps to user-message', () => {
  expect(toAgentObservationEvent(event({ role: 'user', providerEventType: 'item/userMessage' }))?.kind).toBe(
    'user-message'
  );
});

test('a tool call decodes structured name+input from raw, not just the formatted text', () => {
  const neutral = toAgentObservationEvent(
    event({
      role: 'tool',
      providerEventType: 'function_call',
      text: 'Tool call bash {"cmd":"ls"}',
      raw: { name: 'bash', input: { cmd: 'ls' } }
    })
  );
  expect(neutral).toMatchObject({ kind: 'tool-call', streaming: false, tool: { name: 'bash', input: { cmd: 'ls' } } });
});

test('a tool result decodes an output payload', () => {
  const neutral = toAgentObservationEvent(
    event({ role: 'tool', providerEventType: 'function_call_output', raw: { name: 'bash', output: 'ok' } })
  );
  expect(neutral).toMatchObject({ kind: 'tool-result', tool: { name: 'bash', output: 'ok' } });
});

test('a terminal record becomes turn-end and derives its reason from the provider raw', () => {
  expect(toAgentObservationEvent(event({ providerEventType: 'turn/completed', role: 'system' }))).toMatchObject({
    kind: 'turn-end',
    reason: 'completed'
  });
  expect(
    toAgentObservationEvent(
      event({ providerEventType: 'result', role: 'agent', raw: { subtype: 'error', is_error: true } })
    )
  ).toMatchObject({ kind: 'turn-end', reason: 'error' });
  expect(
    toAgentObservationEvent(event({ providerEventType: 'result', role: 'agent', raw: { stop_reason: 'max_tokens' } }))
      ?.reason
  ).toBe('length');
});

test('an explicit turn-start marker fills the turn-start kind the legacy classifier lacks', () => {
  expect(toAgentObservationEvent(event({ providerEventType: 'turn/started', role: 'system' }))?.kind).toBe(
    'turn-start'
  );
});

test('a non-terminal system status notice has no neutral representation and is dropped', () => {
  const idle = toAgentObservationEvent(
    event({
      providerEventType: 'thread/status/changed',
      role: 'system',
      raw: { params: { status: { type: 'working' } } }
    })
  );
  expect(idle).toBeNull();
});

test('provider raw and timestamp pass through, stripped to the neutral shape', () => {
  const neutral = toAgentObservationEvent(
    event({ providerEventType: 'item/agentMessage', text: 'done', createdAt: '2026-07-07T00:00:00Z', raw: { a: 1 } })
  );
  expect(neutral).toMatchObject({ kind: 'assistant-message', at: '2026-07-07T00:00:00Z', raw: { a: 1 } });
});
