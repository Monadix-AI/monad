import type { AgentObservationEvent } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { agentObservationCards } from '../../src/agent-adapters/observation-cards.ts';

function toolEvent(args: {
  id: string;
  kind: 'tool-call' | 'tool-result';
  callId?: string;
  input?: unknown;
  output?: unknown;
  text?: string;
}): AgentObservationEvent {
  return {
    id: args.id,
    kind: args.kind,
    streaming: args.kind === 'tool-call',
    tool: {
      name: 'Bash',
      ...(args.callId === undefined ? {} : { callId: args.callId }),
      ...(args.input === undefined ? {} : { input: args.input }),
      ...(args.output === undefined ? {} : { output: args.output })
    },
    ...(args.text ? { text: args.text } : {}),
    provenance: { contractEvents: [{ id: args.id, callId: args.callId }] }
  };
}

test('tool output completes the partial tool card without changing its id', () => {
  const call = toolEvent({
    id: 'event_call',
    kind: 'tool-call',
    callId: 'call_1',
    input: { command: 'git status' }
  });
  const result = toolEvent({
    id: 'event_result',
    kind: 'tool-result',
    callId: 'call_1',
    output: 'On branch main'
  });

  const partial = agentObservationCards([call], 'codex');
  const completed = agentObservationCards([call, result], 'codex');

  expect(partial).toEqual([
    {
      id: 'event_call',
      dedupeKey: undefined,
      kind: 'tool',
      streaming: true,
      at: undefined,
      payload: { provider: 'codex', call },
      provenance: { contractEvents: [{ id: 'event_call', callId: 'call_1' }] }
    }
  ]);
  expect(completed).toEqual([
    {
      id: 'event_call',
      dedupeKey: undefined,
      kind: 'tool',
      streaming: false,
      at: undefined,
      payload: { provider: 'codex', call, result },
      provenance: {
        contractEvents: [
          { id: 'event_call', callId: 'call_1' },
          { id: 'event_result', callId: 'call_1' }
        ]
      }
    }
  ]);
});

test('a tool call without a callId stays unpaired instead of adopting the next result', () => {
  const call = toolEvent({ id: 'event_call', kind: 'tool-call', input: { command: 'git status' } });
  const foreignResult = toolEvent({
    id: 'event_result',
    kind: 'tool-result',
    callId: 'call_other',
    output: 'output of an unrelated call'
  });

  const cards = agentObservationCards([call, foreignResult], 'codex');

  expect(cards).toEqual([
    {
      id: 'event_call',
      dedupeKey: undefined,
      kind: 'tool',
      streaming: true,
      at: undefined,
      payload: { provider: 'codex', call },
      provenance: { contractEvents: [{ id: 'event_call', callId: undefined }] }
    },
    {
      id: 'event_result',
      dedupeKey: undefined,
      kind: 'tool',
      streaming: false,
      at: undefined,
      payload: { provider: 'codex', event: foreignResult },
      provenance: { contractEvents: [{ id: 'event_result', callId: 'call_other' }] }
    }
  ]);
});

test('a tool call and result that both omit callId render as separate cards', () => {
  const call = toolEvent({ id: 'event_call', kind: 'tool-call', input: { command: 'git status' } });
  const result = toolEvent({ id: 'event_result', kind: 'tool-result', output: 'On branch main' });

  const cards = agentObservationCards([call, result], 'codex');

  expect(cards).toEqual([
    {
      id: 'event_call',
      dedupeKey: undefined,
      kind: 'tool',
      streaming: true,
      at: undefined,
      payload: { provider: 'codex', call },
      provenance: { contractEvents: [{ id: 'event_call', callId: undefined }] }
    },
    {
      id: 'event_result',
      dedupeKey: undefined,
      kind: 'tool',
      streaming: false,
      at: undefined,
      payload: { provider: 'codex', event: result },
      provenance: { contractEvents: [{ id: 'event_result', callId: undefined }] }
    }
  ]);
});
