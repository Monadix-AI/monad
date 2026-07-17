import type { SessionContext } from '#/handlers/session/context.ts';

import { expect, test } from 'bun:test';

import { createManagedExternalAgentMessages } from '#/handlers/session/handlers/managed-external-agent-messages.ts';

test('managed thinking messages persist and emit the author display name snapshot', () => {
  const inserted: Array<{ data?: unknown }> = [];
  const emitted: Array<{ payload: unknown }> = [];
  const ctx = {
    deps: {
      store: {
        findManagedExternalAgentStreamingMessage: () => undefined,
        insertMessage: (
          _id: string,
          _sessionId: string,
          _text: string,
          _createdAt: string,
          _role: string,
          data: unknown
        ) => inserted.push(data as { data?: unknown })
      }
    },
    makeEmit: () => (event: { payload: unknown }) => emitted.push(event),
    persistAndRetire: () => {}
  } as unknown as SessionContext;
  const messages = createManagedExternalAgentMessages(ctx);

  messages.emitManagedExternalAgentThinking(
    'ses_snapshot0000',
    'exa_snapshot0000',
    'pmem_claude_fable',
    undefined,
    'Fable'
  );

  expect(inserted).toEqual([
    expect.objectContaining({
      data: expect.objectContaining({
        agentName: 'pmem_claude_fable',
        agentDisplayName: 'Fable',
        externalAgentSessionId: 'exa_snapshot0000'
      })
    })
  ]);
  expect(emitted[0]).toEqual(
    expect.objectContaining({
      payload: expect.objectContaining({
        agentName: 'pmem_claude_fable',
        agentDisplayName: 'Fable',
        externalAgentSessionId: 'exa_snapshot0000'
      })
    })
  );
});
