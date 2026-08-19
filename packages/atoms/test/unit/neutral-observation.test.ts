import type { MeshAgentObservationEvent } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { toAgentObservationEvent } from '../../src/agent-adapters/shared/observation/neutral-observation.ts';
import { turnEndReasonFromStopValue } from '../../src/agent-adapters/shared/observation/observation-projection.ts';

const event = (over: Partial<MeshAgentObservationEvent>): MeshAgentObservationEvent => ({
  id: 'e',
  role: 'agent',
  text: 't',
  source: 'codex-app-server',
  provenance: { rawEvents: [{ method: 'item/agentMessage', params: { text: 't' } }] },
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

test('a tool call carries the tool fields the adapter normalized, not a re-read of its raw record', () => {
  const neutral = toAgentObservationEvent(
    event({
      role: 'tool',
      providerEventType: 'function_call',
      text: 'Tool call bash {"cmd":"ls"}',
      tool: { name: 'bash', callId: 'call_1', input: { cmd: 'ls' } },
      provenance: { rawEvents: [{ nameOnlyTheAdapterUnderstands: 'bash' }] }
    })
  );
  expect(neutral).toMatchObject({
    kind: 'tool-call',
    streaming: false,
    tool: { name: 'bash', callId: 'call_1', input: { cmd: 'ls' } }
  });
});

test('a projector that only settles its tool fields after a merge supplies them through toolFields', () => {
  const neutral = toAgentObservationEvent(
    event({
      role: 'tool',
      providerEventType: 'function_call',
      text: 'Tool call bash',
      tool: { name: 'bash' },
      provenance: { rawEvents: [{ partial: '{"cmd":' }, { partial: '"ls"}' }] }
    }),
    { toolFields: () => ({ name: 'ignored-because-the-event-declared-one', input: { cmd: 'ls' } }) }
  );
  expect(neutral).toMatchObject({ kind: 'tool-call', tool: { name: 'bash', input: { cmd: 'ls' } } });
});

test('a projected tool name preserves words and stops at a structured payload', () => {
  const projected = (text: string) =>
    toAgentObservationEvent(
      event({ role: 'tool', providerEventType: 'function_call', text, provenance: { rawEvents: [{}] } })
    )?.tool?.name;

  expect([
    projected('Tool call code graph   helper'),
    projected('Tool call code graph   {"query":"monad"}'),
    projected('Tool call Search true'),
    projected('Tool caller Search {"query":"monad"}')
  ]).toEqual(['code graph   helper', 'code graph', 'Search', 'tool']);
});

test('a tool result carries the adapter output, and falls back to the rendered text without one', () => {
  const declared = toAgentObservationEvent(
    event({
      role: 'tool',
      providerEventType: 'function_call_output',
      text: 'ok',
      tool: { name: 'bash', output: { stdout: 'ok' }, status: 'completed' },
      provenance: { rawEvents: [{}] }
    })
  );
  const undeclared = toAgentObservationEvent(
    event({
      role: 'tool',
      providerEventType: 'function_call_output',
      text: 'Tool call bash',
      provenance: { rawEvents: [{}] }
    })
  );
  expect([declared?.tool, undeclared?.tool]).toEqual([
    { name: 'bash', output: { stdout: 'ok' }, status: 'completed' },
    { name: 'bash', output: 'Tool call bash' }
  ]);
});

test('a Hermes tool result preserves its snake-case call id for pairing', () => {
  const output = "Tool 'monad' does not exist.";
  const neutral = toAgentObservationEvent(
    event({
      role: 'tool',
      providerEventType: 'tool_result',
      text: output,
      tool: { callId: 'chatcmpl-tool-1' },
      provenance: {
        rawEvents: [{ tool_call_id: 'chatcmpl-tool-1', tool_name: null, content: output }]
      }
    })
  );

  expect(neutral).toMatchObject({
    kind: 'tool-result',
    text: output,
    tool: { name: 'tool', callId: 'chatcmpl-tool-1', output }
  });
});

test('a terminal record becomes turn-end and carries the reason the adapter mapped', () => {
  const reasonOf = (over: Partial<MeshAgentObservationEvent>) =>
    toAgentObservationEvent(event({ providerEventType: 'result', role: 'agent', ...over }))?.reason;

  expect([
    toAgentObservationEvent(event({ providerEventType: 'turn/completed', role: 'system' }))?.kind,
    reasonOf({}),
    reasonOf({ turnEndReason: 'error' }),
    reasonOf({ turnEndReason: 'length' })
  ]).toEqual(['turn-end', 'completed', 'error', 'length']);
});

test('turn-end mapping recognizes case variants and later explicit failure signals', () => {
  expect([
    turnEndReasonFromStopValue('FAILED'),
    turnEndReasonFromStopValue('unknown-status', 'error'),
    turnEndReasonFromStopValue(undefined, 'MAX_TOKENS'),
    turnEndReasonFromStopValue('unrecognized')
  ]).toEqual(['error', 'error', 'length', 'completed']);
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
      provenance: { rawEvents: [{ params: { status: { type: 'working' } } }] }
    })
  );
  expect(idle).toBeNull();
});

test('provider raw and timestamp pass through, stripped to the neutral shape', () => {
  const provenance = { rawEvents: [{ a: 1 }, { b: 2 }] };
  const neutral = toAgentObservationEvent(
    event({ providerEventType: 'item/agentMessage', text: 'done', createdAt: '2026-07-07T00:00:00Z', provenance })
  );
  expect(neutral).toEqual({
    id: 'e',
    kind: 'assistant-message',
    streaming: false,
    text: 'done',
    at: '2026-07-07T00:00:00Z',
    provenance: {
      contractEvents: [
        event({ providerEventType: 'item/agentMessage', text: 'done', createdAt: '2026-07-07T00:00:00Z', provenance })
      ]
    }
  });
});

test('an in-flight status is folded to `running` whatever spelling the adapter declared', () => {
  const statusOf = (status: string) =>
    toAgentObservationEvent(
      event({
        role: 'tool',
        providerEventType: 'function_call',
        text: 'Tool call bash',
        tool: { name: 'bash', status }
      })
    )?.tool?.status;

  expect([statusOf('in_progress'), statusOf('inProgress'), statusOf('in-progress'), statusOf('completed')]).toEqual([
    'running',
    'running',
    'running',
    'completed'
  ]);
});
