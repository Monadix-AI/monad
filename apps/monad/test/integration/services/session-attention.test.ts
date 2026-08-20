import type { Session } from '@monad/protocol';

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { EventBus, makeEvent } from '#/services/event-bus.ts';
import { SessionAttentionService } from '#/services/session-attention.ts';
import { createStore } from '#/store/db/index.ts';

const chatId = 'ses_ABCDEF123456' as const;
const projectSessionId = 'ses_ABCDEF123457' as const;
const projectId = 'prj_ABCDEF123456' as const;
const at = '2026-07-22T10:00:00.000Z';

let store: ReturnType<typeof createStore>;
let bus: EventBus;
let stop: () => void;

function session(id: Session['id'], project?: Session['projectId']): Session {
  return {
    id,
    ...(project ? { projectId: project } : {}),
    title: id,
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    createdAt: at,
    activityAt: at,
    updatedAt: at
  };
}

beforeEach(() => {
  store = createStore();
  store.insertSession(session(chatId));
  store.insertSession(session(projectSessionId, projectId));
  bus = new EventBus();
  stop = new SessionAttentionService({ store, bus }).start();
});

afterEach(() => {
  stop();
  store.close();
});

test('chat unread is created only at loop end and binds the final assistant message', () => {
  const messageId = newId('msg');
  store.insertMessage(messageId, chatId, 'final', at, 'assistant', { streamStatus: 'complete' });
  const message = store.getMessage(chatId, messageId);
  if (!message) throw new Error('message was not inserted');
  bus.publish(
    makeEvent(chatId, 'session.message.completed', {
      transcriptTargetId: chatId,
      producer: { kind: 'system', subsystem: 'agent-loop' },
      message,
      messageRevision: 1
    })
  );
  expect(store.listSessionAttention([chatId])[0]?.state).toBeNull();

  bus.publish(makeEvent(chatId, 'session.run.completed', { transcriptTargetId: chatId }));

  expect(store.listSessionAttention([chatId])).toEqual([
    {
      sessionId: chatId,
      state: 'unread',
      generationState: null,
      activityAt: expect.any(String),
      unreadItemKeys: [`message:${messageId}`]
    }
  ]);
});

test('project approval and clarify requests remain pending until each request is resolved', () => {
  const messageId = newId('msg');
  store.insertMessage(messageId, projectSessionId, 'agent output', at, 'assistant');
  const message = store.getMessage(projectSessionId, messageId);
  if (!message) throw new Error('message was not inserted');
  bus.publish(
    makeEvent(projectSessionId, 'session.message.created', {
      transcriptTargetId: projectSessionId,
      producer: { kind: 'agent', agentId: 'agt_ABCDEF123456' },
      message,
      messageRevision: 1
    })
  );
  bus.publish(
    makeEvent(projectSessionId, 'tool.approval_requested', {
      requestId: 'gate_ABCDEF123456',
      tool: 'shell',
      input: {}
    })
  );
  bus.publish(
    makeEvent(projectSessionId, 'clarify.requested', {
      requestId: 'clarify_ABCDEF123456',
      question: 'Continue?',
      questionMessageId: 'msg_ABCDEF123458',
      origin: { kind: 'daemon-agent' }
    })
  );

  expect(store.listSessionAttention([projectSessionId])).toEqual([
    {
      sessionId: projectSessionId,
      state: 'need-approval',
      generationState: null,
      activityAt: expect.any(String),
      unreadItemKeys: [`message:${messageId}`]
    }
  ]);

  bus.publish(
    makeEvent(projectSessionId, 'clarify.resolved', {
      requestId: 'clarify_ABCDEF123456',
      answer: 'Yes',
      status: 'answered',
      questionMessageId: 'msg_ABCDEF123458'
    })
  );
  expect(store.listSessionAttention([projectSessionId])[0]?.state).toBe('need-approval');

  bus.publish(
    makeEvent(projectSessionId, 'tool.approval_resolved', {
      requestId: 'gate_ABCDEF123456',
      tool: 'shell',
      allow: true
    })
  );
  expect(store.listSessionAttention([projectSessionId])[0]?.state).toBe('unread');
});

test('mesh approval requests update attention and resolution clears them', () => {
  bus.publish(
    makeEvent(chatId, 'mesh.approval_requested', {
      meshSessionId: 'mesh_ABCDEF123456',
      provider: 'codex',
      requestId: 'gate_ABCDEF123457',
      text: 'Allow command?',
      data: {}
    })
  );
  expect(store.listSessionAttention([chatId])).toEqual([
    {
      sessionId: chatId,
      state: 'need-approval',
      generationState: null,
      activityAt: expect.any(String),
      unreadItemKeys: []
    }
  ]);

  bus.publish(
    makeEvent(chatId, 'mesh.approval_resolved', {
      meshSessionId: 'mesh_ABCDEF123456',
      provider: 'codex',
      requestId: 'gate_ABCDEF123457',
      allow: true
    })
  );
  expect(store.listSessionAttention([chatId])[0]?.state).toBeNull();
});

test('daemon restart rebuilds unresolved action attention from durable events and removes stale projections', () => {
  stop();
  store.applySessionAttentionSource({
    sessionId: chatId,
    itemKey: 'approval:gate_RESOLVED123',
    kind: 'need-approval',
    sourceType: 'approval',
    sourceId: 'gate_RESOLVED123',
    occurredAt: at
  });
  store.appendEvents([
    makeEvent(
      projectSessionId,
      'mesh.approval_requested',
      {
        meshSessionId: 'mesh_ABCDEF123456',
        provider: 'monad',
        requestId: 'gate_PENDING12345',
        text: 'Review tool call',
        data: {}
      },
      { at }
    ),
    makeEvent(chatId, 'tool.approval_requested', { requestId: 'gate_RESOLVED123', tool: 'shell', input: {} }, { at }),
    makeEvent(
      chatId,
      'tool.approval_resolved',
      { requestId: 'gate_RESOLVED123', tool: 'shell', allow: true },
      { at: '2026-07-22T10:00:01.000Z' }
    )
  ]);

  stop = new SessionAttentionService({ store, bus }).start();

  expect(
    store.listSessionAttention([chatId, projectSessionId]).map(({ sessionId, state }) => ({ sessionId, state }))
  ).toEqual([
    { sessionId: chatId, state: null },
    { sessionId: projectSessionId, state: 'need-approval' }
  ]);
});
