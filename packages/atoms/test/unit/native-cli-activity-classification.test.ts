import type { NativeCliObservationEvent } from '@monad/protocol';

import { expect, test } from 'bun:test';
import '../../src/index.ts';

import { builtinAgentAdapters } from '../../src/agent-adapters/index.ts';
import { classifyObservationActivity } from '../../src/agent-adapters/observation-projection.ts';
import {
  nativeCliEventsAreGenerating,
  nativeCliStreamItems
} from '../../src/workspace-experiences/experience/native-cli-observation/native-cli-observation.ts';

const event = (over: Partial<NativeCliObservationEvent>): NativeCliObservationEvent => ({
  id: 'e',
  role: 'agent',
  text: 't',
  source: 'codex-app-server',
  ...over
});

test('every builtin adapter owns the generating/phase classification', () => {
  const withObservation = builtinAgentAdapters.filter((adapter) => adapter.observation);
  expect(withObservation.length).toBeGreaterThanOrEqual(6);
  for (const adapter of withObservation) {
    expect(typeof adapter.observation?.classifyActivity).toBe('function');
  }
});

test('shared classifier maps provider events to a uniform activity kind', () => {
  expect(classifyObservationActivity(event({ providerEventType: 'turn/completed', role: 'system' }))).toBe('turn-end');
  expect(classifyObservationActivity(event({ providerEventType: 'result', role: 'agent' }))).toBe('turn-end');
  expect(
    classifyObservationActivity(
      event({
        providerEventType: 'thread/status/changed',
        role: 'system',
        raw: { params: { status: { type: 'idle' } } }
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
  const codexInFlight = nativeCliStreamItems({
    id: 'c',
    provider: 'codex',
    output: [
      '{"method":"turn/started","params":{"turn":{}}}',
      '{"method":"item/agentMessage/delta","params":{"delta":"working"}}'
    ].join('\n')
  });
  const codexSettled = nativeCliStreamItems({
    id: 'c',
    provider: 'codex',
    output: [
      '{"method":"turn/started","params":{"turn":{}}}',
      '{"method":"item/agentMessage/delta","params":{"delta":"done"}}',
      '{"method":"turn/completed","params":{"turn":{}}}'
    ].join('\n')
  });
  expect(nativeCliEventsAreGenerating(codexInFlight, { provider: 'codex' })).toBe(true);
  expect(nativeCliEventsAreGenerating(codexSettled, { provider: 'codex' })).toBe(false);

  const claudeSettled = nativeCliStreamItems({
    id: 'c',
    provider: 'claude-code',
    output: [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })
    ].join('\n')
  });
  expect(nativeCliEventsAreGenerating(claudeSettled, { provider: 'claude-code' })).toBe(false);
});

test('a lone user input is not generating, but does not clear an in-flight turn', () => {
  const loneUser = nativeCliStreamItems({
    id: 'c',
    provider: 'codex',
    output: '{"items":[{"id":"u1","text":"hi","type":"userMessage","createdAtMs":1783332000000}]}'
  });
  expect(nativeCliEventsAreGenerating(loneUser, { provider: 'codex' })).toBe(false);

  const toolResultMidTurn = nativeCliStreamItems({
    id: 'c',
    provider: 'claude-code',
    output: [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'let me look' }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } })
    ].join('\n')
  });
  expect(nativeCliEventsAreGenerating(toolResultMidTurn, { provider: 'claude-code' })).toBe(true);
});
