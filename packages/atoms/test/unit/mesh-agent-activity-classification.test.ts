import type { MeshAgentObservationEvent } from '@monad/protocol';

import { expect, test } from 'bun:test';
import '../../src/index.ts';

import { builtinAgentAdapters } from '../../src/agent-adapters/index.ts';
import {
  classifyObservationActivity,
  isStreamingObservationFragment
} from '../../src/agent-adapters/observation-projection.ts';
import {
  meshAgentEventsAreGenerating,
  meshAgentStreamItems
} from '../../src/workspace-experiences/experience/mesh-agent-observation/mesh-agent-observation.ts';

const event = (over: Partial<MeshAgentObservationEvent>): MeshAgentObservationEvent => ({
  id: 'e',
  role: 'agent',
  text: 't',
  source: 'codex-app-server',
  provenance: { rawEvents: [{ type: 'test' }] },
  ...over
});

test('every builtin adapter owns the generating/phase + streaming classification', () => {
  const withObservation = builtinAgentAdapters.filter((adapter) => adapter.observation);
  expect(withObservation.length).toBeGreaterThanOrEqual(6);
  for (const adapter of withObservation) {
    expect(typeof adapter.observation?.classifyActivity).toBe('function');
    expect(typeof adapter.observation?.isStreamingFragment).toBe('function');
  }
});

test('streaming-fragment detection is adapter-owned, covering delta/chunk naming', () => {
  expect(isStreamingObservationFragment(event({ providerEventType: 'item/agentMessage/delta' }))).toBe(true);
  expect(isStreamingObservationFragment(event({ providerEventType: 'content_block_delta' }))).toBe(true);
  expect(isStreamingObservationFragment(event({ providerEventType: 'thinking_delta' }))).toBe(true);
  expect(isStreamingObservationFragment(event({ providerEventType: 'item/agentMessage' }))).toBe(false);
  expect(isStreamingObservationFragment(event({ providerEventType: 'result' }))).toBe(false);
});

test('shared classifier maps provider events to a uniform activity kind', () => {
  expect(classifyObservationActivity(event({ providerEventType: 'turn/completed', role: 'system' }))).toBe('turn-end');
  expect(classifyObservationActivity(event({ providerEventType: 'result', role: 'agent' }))).toBe('turn-end');
  expect(
    classifyObservationActivity(
      event({
        providerEventType: 'thread/status/changed',
        role: 'system',
        provenance: { rawEvents: [{ params: { status: { type: 'idle' } } }] }
      })
    )
  ).toBe('turn-end');
  expect(classifyObservationActivity(event({ role: 'tool', providerEventType: 'function_call' }))).toBe('tool-call');
  expect(classifyObservationActivity(event({ role: 'tool', providerEventType: 'function_call_output' }))).toBe(
    'tool-result'
  );
  expect(classifyObservationActivity(event({ providerEventType: 'item/reasoning/textDelta' }))).toBe('thinking');
  expect(classifyObservationActivity(event({ role: 'user', providerEventType: 'item/userMessage' }))).toBe('user');
  expect(classifyObservationActivity(event({ role: 'agent', providerEventType: 'item/agentMessage/delta' }))).toBe(
    'message'
  );
});

test('generating is derived generically from the adapter classification (codex + claude)', () => {
  const codexInFlight = meshAgentStreamItems({
    id: 'c',
    provider: 'codex',
    output: [
      '{"method":"turn/started","params":{"turn":{}}}',
      '{"method":"item/agentMessage/delta","params":{"delta":"working"}}'
    ].join('\n')
  });
  const codexSettled = meshAgentStreamItems({
    id: 'c',
    provider: 'codex',
    output: [
      '{"method":"turn/started","params":{"turn":{}}}',
      '{"method":"item/agentMessage/delta","params":{"delta":"done"}}',
      '{"method":"turn/completed","params":{"turn":{}}}'
    ].join('\n')
  });
  expect(meshAgentEventsAreGenerating(codexInFlight, { provider: 'codex' })).toBe(true);
  expect(meshAgentEventsAreGenerating(codexSettled, { provider: 'codex' })).toBe(false);

  const claudeSettled = meshAgentStreamItems({
    id: 'c',
    provider: 'claude-code',
    output: [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })
    ].join('\n')
  });
  expect(meshAgentEventsAreGenerating(claudeSettled, { provider: 'claude-code' })).toBe(false);
});

test('a lone user input is not generating, but does not clear an in-flight turn', () => {
  const loneUser = meshAgentStreamItems({
    id: 'c',
    provider: 'codex',
    output: '{"items":[{"id":"u1","text":"hi","type":"userMessage","createdAtMs":1783332000000}]}'
  });
  expect(meshAgentEventsAreGenerating(loneUser, { provider: 'codex' })).toBe(false);

  const toolResultMidTurn = meshAgentStreamItems({
    id: 'c',
    provider: 'claude-code',
    output: [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'let me look' }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } })
    ].join('\n')
  });
  expect(meshAgentEventsAreGenerating(toolResultMidTurn, { provider: 'claude-code' })).toBe(true);
});
