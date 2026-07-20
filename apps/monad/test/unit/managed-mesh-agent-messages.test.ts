import type { SessionContext } from '#/handlers/session/context.ts';

import { expect, test } from 'bun:test';

import { createManagedMeshAgentMessages } from '#/handlers/session/handlers/managed-mesh-agent-messages.ts';

test('managed thinking messages persist and emit the author display name snapshot', async () => {
  const delivered: unknown[] = [];
  const ctx = {
    deps: {
      store: {
        findManagedMeshAgentStreamingMessage: () => undefined
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
  const messages = createManagedMeshAgentMessages(ctx);

  await messages.emitManagedMeshAgentThinking(
    'ses_snapshot0000',
    'mesh_snapshot0000',
    'pmem_claude_fable',
    undefined,
    'Fable'
  );

  expect(delivered).toEqual([
    {
      transcriptTargetId: 'ses_snapshot0000',
      idempotencyKey: expect.stringMatching(/^idem_/),
      producer: {
        kind: 'mesh-agent',
        meshSessionId: 'mesh_snapshot0000',
        agentName: 'pmem_claude_fable'
      },
      role: 'assistant',
      type: 'text',
      text: '',
      data: {
        memberId: 'pmem_claude_fable',
        agentName: 'pmem_claude_fable',
        agentDisplayName: 'Fable',
        meshSessionId: 'mesh_snapshot0000',
        reasoning: 'Thinking',
        source: 'managed-mesh-agent'
      },
      includeInContext: false
    }
  ]);
});

test('project post completes its room message without settling the provider turn', async () => {
  const persisted: Array<Array<{ sessionId: string; type: string; payload: unknown }>> = [];
  const ctx = {
    deps: {
      store: {
        findManagedMeshAgentStreamingMessage: () => undefined
      }
    },
    messageIngress: {
      deliver: () => Promise.resolve({ id: 'msg_project_post' })
    },
    makeEmit:
      (round: Array<{ sessionId: string; type: string; payload: unknown }>) =>
      (event: { sessionId: string; type: string; payload: unknown }) =>
        round.push(event),
    persistAndRetire: (_sessionId: string, round: Array<{ sessionId: string; type: string; payload: unknown }>) =>
      persisted.push(round)
  } as unknown as SessionContext;

  const result = await createManagedMeshAgentMessages(ctx).completeManagedMeshAgentThinking({
    sessionId: 'ses_projectpost1',
    meshSessionId: 'mesh_projectpost1',
    agentName: 'pmem_codex_writer',
    agentDisplayName: 'Writer',
    text: 'Checkpoint posted while provider continues.'
  });

  expect({ result, events: persisted.flat() }).toEqual({
    result: { messageId: 'msg_project_post' },
    events: []
  });
});
