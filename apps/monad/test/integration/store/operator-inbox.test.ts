import type { Event, Session, WorkplaceProject } from '@monad/protocol';

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
        questions: [
          {
            id: 'environment',
            question: 'Which environment?',
            options: ['staging', 'production'],
            mode: 'single',
            allowOther: false
          },
          {
            id: 'regions',
            question: 'Which regions?',
            options: ['us', 'eu'],
            mode: 'multiple',
            allowOther: true
          }
        ],
        questionMessageId: 'msg_QUESTION0000',
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

test('operator inbox collapses mirrored approvals onto the project session', () => {
  const project: WorkplaceProject = {
    id: 'prj_ABCDEF123456',
    title: 'Project',
    state: 'active',
    archived: false,
    memberTemplates: [],
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z'
  };
  const projectSession: Session = {
    ...session,
    id: 'ses_PROJEC123456',
    projectId: project.id,
    title: 'Project session'
  };
  store.insertWorkplaceProject(project);
  store.insertSession(projectSession);
  store.appendEvents([
    {
      id: 'evt_MIRROR123456',
      sessionId: session.id,
      type: 'mesh.approval_requested',
      actorAgentId: null,
      payload: {
        requestId: 'gate_MIRROR123456',
        meshSessionId: 'mesh_MIRROR123456',
        provider: 'monad',
        text: 'tool',
        data: { tool: 'monad__project_post' }
      },
      at: '2026-07-21T00:00:04.000Z'
    } as Event,
    {
      id: 'evt_MIRROR123457',
      sessionId: projectSession.id,
      type: 'mesh.approval_requested',
      actorAgentId: null,
      payload: {
        requestId: 'gate_MIRROR123456',
        meshSessionId: 'mesh_MIRROR123456',
        provider: 'monad',
        text: 'tool',
        data: { tool: 'monad__project_post' }
      },
      at: '2026-07-21T00:00:04.000Z'
    } as Event
  ]);

  expect(
    store
      .listOperatorInbox({ filter: 'needs-response', limit: 100 })
      .items.filter((item) => item.itemKey === 'approval:gate_MIRROR123456')
  ).toEqual([
    expect.objectContaining({
      itemKey: 'approval:gate_MIRROR123456',
      projectId: project.id,
      sessionId: projectSession.id,
      actionState: 'needs-response'
    })
  ]);
});

test('archiving a session removes its items from the operator inbox until it is restored', () => {
  store.updateSession(session.id, { archived: true });

  // presence-ok: archiving removes every item owned by the session from the inbox projection
  expect({
    itemKeys: store.listOperatorInbox({ filter: 'all', limit: 100 }).items.map((item) => item.itemKey),
    summary: store.operatorInboxSummary()
  }).toEqual({
    itemKeys: [],
    summary: { unreadCount: 0, needsResponseCount: 0 }
  });

  store.updateSession(session.id, { archived: false });

  expect({
    itemKeys: store.listOperatorInbox({ filter: 'all', limit: 100 }).items.map((item) => item.itemKey),
    summary: store.operatorInboxSummary()
  }).toEqual({
    itemKeys: ['approval:req_ABCDEF123456', 'hitl:clarify_ABCDEF123456', 'mention:msg_ABCDEF123456'],
    summary: { unreadCount: 3, needsResponseCount: 2 }
  });
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

test('operator inbox restores one read item without changing action state', () => {
  store.markOperatorInboxRead(['hitl:clarify_ABCDEF123456'], '2026-07-22T00:00:00.000Z');

  expect(store.markOperatorInboxUnread(['hitl:clarify_ABCDEF123456'])).toEqual({
    itemKeys: ['hitl:clarify_ABCDEF123456']
  });
  expect(
    store.listOperatorInbox({ filter: 'unread', limit: 100 }).items.map((item) => ({
      itemKey: item.itemKey,
      actionState: item.actionState
    }))
  ).toEqual([
    { itemKey: 'approval:req_ABCDEF123456', actionState: 'needs-response' },
    { itemKey: 'hitl:clarify_ABCDEF123456', actionState: 'needs-response' },
    { itemKey: 'mention:msg_ABCDEF123456', actionState: 'informational' }
  ]);
});

test('operator inbox marks every current item read independently of list limits', () => {
  expect(store.markAllOperatorInboxRead('2026-07-22T00:00:00.000Z')).toEqual({
    readAt: '2026-07-22T00:00:00.000Z',
    count: 3
  });
  expect(store.listOperatorInbox({ filter: 'unread', limit: 1 }).items).toEqual([]);
  expect(store.operatorInboxSummary()).toEqual({ unreadCount: 0, needsResponseCount: 2 });
  expect(store.markAllOperatorInboxRead('2026-07-22T00:01:00.000Z')).toEqual({
    readAt: '2026-07-22T00:01:00.000Z',
    count: 0
  });
});

test('operator inbox projects one actionable multi-question card', () => {
  const hitl = store
    .listOperatorInbox({ filter: 'needs-response', limit: 100 })
    .items.find((item) => item.kind === 'hitl');

  expect(hitl).toMatchObject({
    requestId: 'clarify_ABCDEF123456',
    questions: [
      {
        id: 'environment',
        question: 'Which environment?',
        options: ['staging', 'production'],
        mode: 'single',
        allowOther: false
      },
      {
        id: 'regions',
        question: 'Which regions?',
        options: ['us', 'eu'],
        mode: 'multiple',
        allowOther: true
      }
    ]
  });
});

test('operator inbox filters unread and completed clarification items', () => {
  store.appendEvents([
    {
      id: 'evt_ABCDEF123458',
      sessionId: session.id,
      type: 'clarify.resolved',
      actorAgentId: null,
      payload: {
        requestId: 'clarify_ABCDEF123456',
        answer: 'production',
        questionMessageId: 'msg_QUESTION0000',
        reason: 'answered'
      },
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
