import type { SessionContext } from '#/handlers/session/context.ts';

import { expect, test } from 'bun:test';

import { createManagedMeshAgentMessages } from '#/handlers/session/handlers/managed-mesh-agent-messages.ts';

test('terminal provider output settles the MeshAgent turn without a pending thinking message', async () => {
  const persisted: Array<Array<{ sessionId: string; type: string; payload: unknown }>> = [];
  const ctx = {
    deps: {
      store: {
        findManagedMeshAgentStreamingMessage: () => undefined
      }
    },
    makeEmit:
      (round: Array<{ sessionId: string; type: string; payload: unknown }>) =>
      (event: { sessionId: string; type: string; payload: unknown }) =>
        round.push(event),
    persistAndRetire: (_sessionId: string, round: Array<{ sessionId: string; type: string; payload: unknown }>) =>
      persisted.push(round)
  } as unknown as SessionContext;

  const result = await createManagedMeshAgentMessages(ctx).retireManagedMeshAgentThinking(
    'ses_terminal0000',
    'mesh_terminal0000',
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
        type: 'mesh.turn_settled',
        payload: { meshSessionId: 'mesh_terminal0000' }
      }
    ]
  });
});
