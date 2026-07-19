import type { SessionContext } from '#/handlers/session/context.ts';

import { expect, test } from 'bun:test';

import { createManagedExternalAgentMessages } from '#/handlers/session/handlers/managed-external-agent-messages.ts';

test('managed thinking messages persist and emit the author display name snapshot', async () => {
  const delivered: unknown[] = [];
  const ctx = {
    deps: {
      store: {
        findManagedExternalAgentStreamingMessage: () => undefined
      }
    },
    messageIngress: {
      begin: (command: unknown) => {
        delivered.push(command);
        return Promise.resolve({ id: 'msg_snapshot0000' });
      }
    },
    makeEmit: () => () => {},
    persistAndRetire: () => {}
  } as unknown as SessionContext;
  const messages = createManagedExternalAgentMessages(ctx);

  await messages.emitManagedExternalAgentThinking(
    'ses_snapshot0000',
    'exa_snapshot0000',
    'pmem_claude_fable',
    undefined,
    'Fable'
  );

  expect(delivered).toEqual([
    {
      transcriptTargetId: 'ses_snapshot0000',
      idempotencyKey: expect.stringMatching(/^idem_/),
      producer: {
        kind: 'external-agent',
        externalAgentSessionId: 'exa_snapshot0000',
        agentName: 'pmem_claude_fable'
      },
      role: 'assistant',
      type: 'text',
      text: '',
      data: {
        agentName: 'pmem_claude_fable',
        agentDisplayName: 'Fable',
        externalAgentSessionId: 'exa_snapshot0000',
        reasoning: 'Thinking',
        source: 'managed-external-agent'
      },
      includeInContext: false
    }
  ]);
});
