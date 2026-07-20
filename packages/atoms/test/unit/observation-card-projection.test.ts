import type { AgentObservationEvent } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { agentObservationCards } from '../../src/agent-adapters/observation-cards.ts';

function toolEvent(args: {
  id: string;
  kind: 'tool-call' | 'tool-result';
  callId: string;
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
      callId: args.callId,
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
