import type { Event, Session } from '@monad/protocol';

import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createStore } from '#/store/db/index.ts';

let store: ReturnType<typeof createStore>;

const session: Session = {
  id: 'ses_ABCDEF123456',
  title: 'Operator Inbox',
  state: 'active',
  agentIds: [],
  archived: false,
  restoreCount: 0,
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z'
};

beforeEach(() => {
  store = createStore();
  store.insertSession(session);
  store.insertMessage(
    'msg_ABCDEF123456',
    session.id,
    '@[name="zeke" id="human"] review this',
    '2026-07-21T00:00:01.000Z',
    'assistant'
  );
  store.appendEvents([
    {
      id: 'evt_ABCDEF123456',
      sessionId: session.id,
      type: 'clarify.requested',
      actorAgentId: null,
      payload: {
        requestId: 'clarify_ABCDEF123456',
        question: 'Which environment?',
        options: ['staging', 'production']
      },
      at: '2026-07-21T00:00:02.000Z'
    } as Event,
    {
      id: 'evt_ABCDEF123457',
      sessionId: session.id,
      type: 'tool.approval_requested',
      actorAgentId: null,
      payload: { requestId: 'req_ABCDEF123456', tool: 'shell_exec', input: { command: 'bun test' } },
      at: '2026-07-21T00:00:03.000Z'
    } as Event
  ]);
});

afterEach(() => store.close());

test('operator inbox globally orders mentions, approvals, and HITL before applying the limit', () => {
  expect(store.listOperatorInbox({ filter: 'all', limit: 2 }).items.map((item) => item.itemKey)).toEqual([
    'approval:req_ABCDEF123456',
    'hitl:clarify_ABCDEF123456'
  ]);
});

test('operator inbox keeps read state independent from required response state', () => {
  store.markOperatorInboxRead(['hitl:clarify_ABCDEF123456'], '2026-07-21T00:01:00.000Z');
  store.markOperatorInboxRead(['hitl:clarify_ABCDEF123456'], '2026-07-21T00:02:00.000Z');

  const hitl = store
    .listOperatorInbox({ filter: 'all', limit: 100 })
    .items.find((item) => item.itemKey === 'hitl:clarify_ABCDEF123456');
  expect(hitl).toMatchObject({
    readAt: '2026-07-21T00:01:00.000Z',
    actionState: 'needs-response'
  });
  expect(store.operatorInboxSummary()).toEqual({ unreadCount: 2, needsResponseCount: 2 });
});

test('operator inbox filters unread and completed clarification items', () => {
  store.appendEvents([
    {
      id: 'evt_ABCDEF123458',
      sessionId: session.id,
      type: 'clarify.resolved',
      actorAgentId: null,
      payload: { requestId: 'clarify_ABCDEF123456', answer: 'production', reason: 'answered' },
      at: '2026-07-21T00:00:04.000Z'
    } as Event
  ]);

  expect(store.listOperatorInbox({ filter: 'completed', limit: 100 }).items).toEqual([
    expect.objectContaining({
      itemKey: 'hitl:clarify_ABCDEF123456',
      actionState: 'completed',
      answer: 'production'
    })
  ]);
  expect(store.listOperatorInbox({ filter: 'needs-response', limit: 100 }).items.map((item) => item.kind)).toEqual([
    'approval'
  ]);
});
