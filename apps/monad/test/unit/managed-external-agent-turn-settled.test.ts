import type { SessionContext } from '#/handlers/session/context.ts';

import { expect, test } from 'bun:test';

import { createManagedExternalAgentMessages } from '#/handlers/session/handlers/managed-external-agent-messages.ts';

test('terminal provider output settles the external agent turn without a pending thinking message', async () => {
  const persisted: Array<Array<{ sessionId: string; type: string; payload: unknown }>> = [];
  const ctx = {
    deps: {
      store: {
        findManagedExternalAgentStreamingMessage: () => undefined
      }
    },
    makeEmit:
      (round: Array<{ sessionId: string; type: string; payload: unknown }>) =>
      (event: { sessionId: string; type: string; payload: unknown }) =>
        round.push(event),
    persistAndRetire: (_sessionId: string, round: Array<{ sessionId: string; type: string; payload: unknown }>) =>
      persisted.push(round)
  } as unknown as SessionContext;

  const result = await createManagedExternalAgentMessages(ctx).retireManagedExternalAgentThinking(
    'ses_terminal0000',
    'exa_terminal0000',
    'pmem_claude_sonnet'
  );

  expect({
    result,
    events: persisted.flat().map(({ sessionId, type, payload }) => ({ sessionId, type, payload }))
  }).toEqual({
    result: null,
    events: [
      {
        sessionId: 'ses_terminal0000',
        type: 'external_agent.turn_settled',
        payload: { externalAgentSessionId: 'exa_terminal0000' }
      }
    ]
  });
});
