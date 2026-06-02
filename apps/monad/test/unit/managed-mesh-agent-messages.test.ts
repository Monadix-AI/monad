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
        source: 'managed-mesh-agent'
      },
      includeInContext: false
    }
  ]);
});

test('project post completes its room message without settling the provider turn', async () => {
  const persisted: Array<Array<{ sessionId: string; type: string; payload: unknown }>> = [];
  const message = {
    id: 'msg_project_post' as const,
    sessionId: 'ses_projectpost1' as const,
    role: 'assistant' as const,
    text: 'Checkpoint posted while provider continues.',
    type: 'text' as const,
    stream: { status: 'settled' as const },
    active: true,
    createdAt: '2026-07-24T00:00:00.000Z'
  };
  const ctx = {
    deps: {
      store: {
        findManagedMeshAgentStreamingMessage: () => undefined
      }
    },
    messageIngress: {
      deliverWithOutcome: () => Promise.resolve({ message, changed: true })
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
    result: { messageId: 'msg_project_post', message, changed: true },
    events: []
  });
});

test('after restart, completing by projectMemberId reuses the legacy alias-keyed active placeholder', async () => {
  // Restart: the in-memory pending map is empty, so completion falls back to the DB locator. The active
  // placeholder was emitted before the cutover keyed by the alias 'codex'; completion now addresses it by
  // 'pmem_codex'. It must settle the SAME message (canonical data, one reply) — never emit a second one.
  const settled: unknown[] = [];
  let begins = 0;
  let delivers = 0;
  const ctx = {
    deps: {
      store: {
        findManagedMeshAgentStreamingMessage: (_target: string, meshSessionId: string) =>
          meshSessionId === 'mesh_restart00000' ? 'msg_legacy00000' : undefined,
        getMessage: () => ({
          data: {
            memberId: 'codex',
            agentName: 'codex',
            agentDisplayName: 'Codex',
            meshSessionId: 'mesh_restart00000',
            source: 'managed-mesh-agent'
          }
        })
      }
    },
    messageIngress: {
      begin: () => {
        begins += 1;
        return Promise.resolve({ id: 'msg_should_not_begin' });
      },
      deliver: () => {
        delivers += 1;
        return Promise.resolve({ id: 'msg_should_not_deliver' });
      },
      settleWithOutcome: (command: { messageId: string }) => {
        settled.push(command);
        return Promise.resolve({
          message: { id: command.messageId },
          changed: true
        });
      }
    },
    makeEmit: () => () => {},
    persistAndRetire: () => {}
  } as unknown as SessionContext;

  const result = await createManagedMeshAgentMessages(ctx).completeManagedMeshAgentThinking({
    sessionId: 'ses_restart00000',
    meshSessionId: 'mesh_restart00000',
    agentName: 'pmem_codex',
    text: 'Final answer'
  });

  expect({ result, settled, begins, delivers }).toEqual({
    result: {
      messageId: 'msg_legacy00000',
      message: expect.objectContaining({ id: 'msg_legacy00000' }),
      changed: true
    },
    begins: 0,
    delivers: 0,
    settled: [
      {
        transcriptTargetId: 'ses_restart00000',
        messageId: 'msg_legacy00000',
        idempotencyKey: expect.stringMatching(/^idem_/),
        producer: { kind: 'mesh-agent', meshSessionId: 'mesh_restart00000', agentName: 'pmem_codex' },
        text: 'Final answer',
        type: 'text',
        data: {
          memberId: 'pmem_codex',
          agentName: 'pmem_codex',
          agentDisplayName: 'Codex',
          meshSessionId: 'mesh_restart00000',
          source: 'managed-mesh-agent'
        },
        includeInContext: true
      }
    ]
  });
});

test('after restart, retiring by projectMemberId removes the legacy alias-keyed active placeholder', async () => {
  const removed: unknown[] = [];
  const settled: unknown[] = [];
  const ctx = {
    deps: {
      store: {
        findManagedMeshAgentStreamingMessage: (_target: string, meshSessionId: string) =>
          meshSessionId === 'mesh_restart00000' ? 'msg_legacy00000' : undefined
      }
    },
    messageIngress: {
      remove: (command: { messageId: string }) => {
        removed.push(command);
        return Promise.resolve();
      },
      settle: (command: unknown) => {
        settled.push(command);
        return Promise.resolve({ id: 'x' });
      }
    },
    makeEmit: () => () => {},
    persistAndRetire: () => {}
  } as unknown as SessionContext;

  const messageId = await createManagedMeshAgentMessages(ctx).retireManagedMeshAgentThinking(
    'ses_restart00000',
    'mesh_restart00000',
    'pmem_codex'
  );

  expect({ messageId, removed, settledCount: settled.length }).toEqual({
    messageId: 'msg_legacy00000',
    settledCount: 0,
    removed: [
      {
        transcriptTargetId: 'ses_restart00000',
        messageId: 'msg_legacy00000',
        idempotencyKey: expect.stringMatching(/^idem_/),
        producer: { kind: 'mesh-agent', meshSessionId: 'mesh_restart00000', agentName: 'pmem_codex' }
      }
    ]
  });
});
