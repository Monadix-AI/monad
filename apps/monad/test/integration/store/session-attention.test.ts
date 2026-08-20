import type { Session, WorkplaceProject } from '@monad/protocol';

import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createStore } from '#/store/db/index.ts';

const sessionId = 'ses_ABCDEF123456' as const;
const session: Session = {
  id: sessionId,
  title: 'Attention',
  state: 'active',
  agentIds: [],
  archived: false,
  restoreCount: 0,
  activityAt: '2026-07-22T09:00:00.000Z',
  createdAt: '2026-07-22T09:00:00.000Z',
  updatedAt: '2026-07-22T09:00:00.000Z'
};

let store: ReturnType<typeof createStore>;

beforeEach(() => {
  store = createStore();
  store.insertSession(session);
});

afterEach(() => store.close());

test('exact-key consumption leaves unread activity that arrived after the snapshot', () => {
  store.insertMessage(
    'msg_ABCDEF123456',
    sessionId,
    '<mention id="human">Human</mention> Review complete.',
    '2026-07-22T10:00:00.000Z',
    'assistant',
    { streamStatus: 'complete' }
  );
  store.applySessionAttentionSource({
    sessionId,
    itemKey: 'message:msg_ABCDEF123456',
    kind: 'unread',
    sourceType: 'message',
    sourceId: 'msg_ABCDEF123456',
    occurredAt: '2026-07-22T10:00:00.000Z'
  });
  store.applySessionAttentionSource({
    sessionId,
    itemKey: 'approval:req_ABCDEF123456',
    kind: 'need-approval',
    sourceType: 'approval',
    sourceId: 'req_ABCDEF123456',
    occurredAt: '2026-07-22T10:00:00.500Z'
  });
  const snapshot = store.listSessionAttention([sessionId]);
  store.applySessionAttentionSource({
    sessionId,
    itemKey: 'message:msg_ABCDEF123457',
    kind: 'unread',
    sourceType: 'message',
    sourceId: 'msg_ABCDEF123457',
    occurredAt: '2026-07-22T10:00:01.000Z'
  });

  const result = store.consumeSessionAttention(
    sessionId,
    snapshot[0]?.unreadItemKeys ?? [],
    'open',
    '2026-07-22T10:00:02.000Z'
  );

  expect({
    result,
    summaries: store.listSessionAttention([sessionId]),
    inbox: store.listOperatorInbox().items.map((item) => ({ itemKey: item.itemKey, readAt: item.readAt }))
  }).toEqual({
    result: { consumedItemKeys: ['message:msg_ABCDEF123456'] },
    summaries: [
      {
        sessionId,
        state: 'need-approval',
        generationState: null,
        activityAt: '2026-07-22T10:00:01.000Z',
        unreadItemKeys: ['message:msg_ABCDEF123457']
      }
    ],
    inbox: [{ itemKey: 'mention:msg_ABCDEF123456', readAt: '2026-07-22T10:00:02.000Z' }]
  });
});

test('attention summary preserves unread keys behind the highest unresolved need state', () => {
  store.applySessionAttentionSource({
    sessionId,
    itemKey: 'message:msg_ABCDEF123456',
    kind: 'unread',
    sourceType: 'message',
    sourceId: 'msg_ABCDEF123456',
    occurredAt: '2026-07-22T10:00:00.000Z'
  });
  store.applySessionAttentionSource({
    sessionId,
    itemKey: 'response:clarify_ABCDEF123456',
    kind: 'need-response',
    sourceType: 'clarify',
    sourceId: 'clarify_ABCDEF123456',
    occurredAt: '2026-07-22T10:00:01.000Z'
  });
  store.applySessionAttentionSource({
    sessionId,
    itemKey: 'approval:req_ABCDEF123456',
    kind: 'need-approval',
    sourceType: 'approval',
    sourceId: 'req_ABCDEF123456',
    occurredAt: '2026-07-22T10:00:02.000Z'
  });

  expect(store.listSessionAttention([sessionId])).toEqual([
    {
      sessionId,
      state: 'need-approval',
      generationState: null,
      activityAt: '2026-07-22T10:00:02.000Z',
      unreadItemKeys: ['message:msg_ABCDEF123456']
    }
  ]);
});

test('attention summary reports the active generation lifecycle and its terminal failure', () => {
  const messageId = 'msg_ABCDEF123456';
  store.insertMessage(messageId, sessionId, '', '2026-07-22T10:00:00.000Z', 'assistant', {
    streamStatus: 'pending'
  });

  expect(store.listSessionAttention([sessionId])).toEqual([
    {
      sessionId,
      state: null,
      generationState: 'running',
      activityAt: '2026-07-22T09:00:00.000Z',
      unreadItemKeys: []
    }
  ]);

  expect(store.setGenStatus(sessionId, messageId, 'error', '2026-07-22T10:00:01.000Z')).toBe(true);
  expect(store.listSessionAttention([sessionId])).toEqual([
    {
      sessionId,
      state: null,
      generationState: 'error',
      activityAt: '2026-07-22T09:00:00.000Z',
      unreadItemKeys: []
    }
  ]);
});

test('project reorder persists neighbor order and rejects a stale revision', () => {
  const project = (id: WorkplaceProject['id'], title: string, updatedAt: string): WorkplaceProject => ({
    id,
    title,
    state: 'active',
    archived: false,
    memberTemplates: [],
    createdAt: updatedAt,
    updatedAt
  });
  const first = project('prj_ABCDEF123456', 'First', '2026-07-22T10:00:00.000Z');
  const second = project('prj_ABCDEF123457', 'Second', '2026-07-22T10:00:01.000Z');
  const third = project('prj_ABCDEF123458', 'Third', '2026-07-22T10:00:02.000Z');
  store.insertWorkplaceProject(first);
  store.insertWorkplaceProject(second);
  store.insertWorkplaceProject(third);
  const revision = store.getWorkplaceProjectOrderRevision();

  expect(store.listWorkplaceProjects().map((project) => project.id)).toEqual([third.id, second.id, first.id]);
  expect(
    store.reorderWorkplaceProject({ projectId: first.id, beforeProjectId: third.id, expectedRevision: revision })
  ).toEqual({ projectId: first.id, orderRevision: revision + 1 });
  expect(store.listWorkplaceProjects().map((project) => project.id)).toEqual([first.id, third.id, second.id]);
  expect(() =>
    store.reorderWorkplaceProject({ projectId: second.id, afterProjectId: first.id, expectedRevision: revision })
  ).toThrow('Project order changed; refresh and retry');
});
