import type { NativeCliSessionRow } from '@/store/db/index.ts';

import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createStore } from '@/store/db/index.ts';

let store: ReturnType<typeof createStore>;

beforeEach(() => {
  store = createStore();
});

afterEach(() => {
  store.close();
});

const row: NativeCliSessionRow = {
  id: 'ncli_1',
  transcriptTargetId: 'prj_project',
  agentName: 'codex',
  provider: 'codex' as const,
  workingPath: '/tmp/project',
  launchMode: 'pty' as const,
  runtimeRole: 'interactive' as const,
  agentRuntimeId: null,
  agentRuntimeTokenHash: null,
  lastDeliveredSeq: 0,
  lastVisibleSeq: 0,
  state: 'running' as const,
  pid: 123,
  providerSessionRef: null,
  outputSnapshot: '',
  exitCode: null,
  startedAt: '2026-06-28T00:00:00.000Z',
  updatedAt: '2026-06-28T00:00:00.000Z',
  exitedAt: null
};

test('native CLI session lifecycle stores output snapshots and exit status', () => {
  store.upsertNativeCliSession(row);
  store.appendNativeCliOutput('ncli_1', 'hello', 32);
  store.updateNativeCliSessionRef('ncli_1', 'provider-session-1');
  store.closeNativeCliSession('ncli_1', '2026-06-28T00:00:01.000Z', 0);

  const rows = store.listNativeCliSessionsForTranscriptTarget('prj_project');
  expect(rows).toHaveLength(1);
  expect(rows[0]?.outputSnapshot).toBe('hello');
  expect(rows[0]?.providerSessionRef).toBe('provider-session-1');
  expect(rows[0]?.state).toBe('exited');
  expect(rows[0]?.exitCode).toBe(0);
});

test('closeNativeCliSession does not overwrite terminal native CLI session state', () => {
  store.upsertNativeCliSession(row);
  store.closeNativeCliSession('ncli_1', '2026-06-28T00:00:01.000Z', null, 'stopped');
  store.closeNativeCliSession('ncli_1', '2026-06-28T00:00:02.000Z', 0, 'exited');

  const closed = store.getNativeCliSession('ncli_1');
  expect(closed?.state).toBe('stopped');
  expect(closed?.exitCode).toBeNull();
  expect(closed?.exitedAt).toBe('2026-06-28T00:00:01.000Z');
});

test('reconcileOrphanedNativeCliSessions marks live native CLI rows stopped on daemon restart', () => {
  store.upsertNativeCliSession(row);
  store.upsertNativeCliSession({ ...row, id: 'ncli_starting', state: 'starting', pid: null });
  store.upsertNativeCliSession({ ...row, id: 'ncli_done', state: 'exited', pid: 456, exitedAt: row.updatedAt });

  const reconciled = store.reconcileOrphanedNativeCliSessions(() => {});

  expect(reconciled).toBe(2);
  expect(store.getNativeCliSession('ncli_1')?.state).toBe('stopped');
  expect(store.getNativeCliSession('ncli_starting')?.state).toBe('stopped');
  expect(store.getNativeCliSession('ncli_done')?.state).toBe('exited');
});

test('reconcileOrphanedNativeCliSessions preserves managed provider refs for later cold resume', () => {
  store.upsertNativeCliSession({
    ...row,
    id: 'ncli_managed_running',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: 'ncli_managed_running',
    agentRuntimeTokenHash: 'token-hash',
    providerSessionRef: 'provider-thread-1',
    lastDeliveredSeq: 10,
    lastVisibleSeq: 8
  });

  expect(store.reconcileOrphanedNativeCliSessions(() => {})).toBe(1);

  expect(store.getNativeCliSession('ncli_managed_running')).toMatchObject({
    state: 'stopped',
    providerSessionRef: 'provider-thread-1',
    lastDeliveredSeq: 10,
    lastVisibleSeq: 8
  });
});

test('native CLI inbox diagnostics count pending visible messages', () => {
  store.insertMessage('msg_1', 'prj_project', 'seen', '2026-06-28T00:00:01.000Z', 'user');
  store.insertMessage('msg_2', 'prj_project', 'pending one', '2026-06-28T00:00:02.000Z', 'user');
  store.insertMessage('msg_3', 'prj_project', 'pending two', '2026-06-28T00:00:03.000Z', 'user');
  store.upsertNativeCliSession({ ...row, id: 'ncli_inbox_diag', lastVisibleSeq: 1, lastDeliveredSeq: 3 });
  store.enqueueNativeCliInboxItem('ncli_inbox_diag', 2);
  store.enqueueNativeCliInboxItem('ncli_inbox_diag', 3);

  expect(store.countNativeCliInbox('ncli_inbox_diag')).toBe(2);
});

test('native CLI inbox diagnostics ignore inactive messages', () => {
  store.insertMessage('msg_1', 'prj_project', 'pending one', '2026-06-28T00:00:01.000Z', 'user');
  store.insertMessage('msg_2', 'prj_project', 'pending two', '2026-06-28T00:00:02.000Z', 'user');
  store.upsertNativeCliSession({ ...row, id: 'ncli_inbox_diag', lastVisibleSeq: 0, lastDeliveredSeq: 2 });
  store.enqueueNativeCliInboxItem('ncli_inbox_diag', 1);
  store.enqueueNativeCliInboxItem('ncli_inbox_diag', 2);
  store.restoreMessages('prj_project', 'msg_2');

  expect(store.countNativeCliInbox('ncli_inbox_diag')).toBe(1);
});

test('native CLI inbox only exposes messages explicitly queued for that runtime', () => {
  store.insertMessage('msg_1', 'prj_project', 'unqueued', '2026-06-28T00:00:01.000Z', 'user');
  store.insertMessage('msg_2', 'prj_project', 'queued', '2026-06-28T00:00:02.000Z', 'user');
  store.upsertNativeCliSession({ ...row, id: 'ncli_inbox_diag', lastVisibleSeq: 0, lastDeliveredSeq: 0 });

  store.enqueueNativeCliInboxItem('ncli_inbox_diag', 2);

  expect(store.listNativeCliInbox('ncli_inbox_diag')).toEqual([
    expect.objectContaining({
      seq: 2,
      deliveryState: 'queued',
      message: expect.objectContaining({ id: 'msg_2', text: 'queued' })
    })
  ]);
});

test('native CLI inbox delivery and visible cursors update queued item state', () => {
  store.insertMessage('msg_1', 'prj_project', 'queued', '2026-06-28T00:00:01.000Z', 'user');
  store.upsertNativeCliSession({ ...row, id: 'ncli_inbox_diag', lastVisibleSeq: 0, lastDeliveredSeq: 0 });
  store.enqueueNativeCliInboxItem('ncli_inbox_diag', 1);

  store.markNativeCliInboxDelivered('ncli_inbox_diag', 1);
  expect(store.listNativeCliInbox('ncli_inbox_diag')[0]?.deliveryState).toBe('delivered');

  store.markNativeCliInboxVisible('ncli_inbox_diag', 1);
  expect(store.listNativeCliInbox('ncli_inbox_diag')).toEqual([]);
  expect(store.getNativeCliSession('ncli_inbox_diag')).toMatchObject({ lastDeliveredSeq: 1, lastVisibleSeq: 1 });
  expect(store.hasUnconsumedNativeCliInbox('ncli_inbox_diag')).toBe(true);

  store.markNativeCliInboxConsumed('ncli_inbox_diag', 1);
  expect(store.hasUnconsumedNativeCliInbox('ncli_inbox_diag')).toBe(false);
});

test('provider session refs are unique per project session and provider when present', () => {
  store.upsertNativeCliSession({ ...row, id: 'ncli_1', providerSessionRef: 'provider-thread-1' });
  store.upsertNativeCliSession({ ...row, id: 'ncli_2', providerSessionRef: null });
  store.upsertNativeCliSession({ ...row, id: 'ncli_3', providerSessionRef: null });
  store.upsertNativeCliSession({
    ...row,
    id: 'ncli_other_project',
    transcriptTargetId: 'prj_other',
    providerSessionRef: 'provider-thread-1'
  });
  store.upsertNativeCliSession({
    ...row,
    id: 'ncli_other_provider',
    provider: 'claude-code',
    providerSessionRef: 'provider-thread-1'
  });

  expect(() =>
    store.upsertNativeCliSession({ ...row, id: 'ncli_duplicate', providerSessionRef: 'provider-thread-1' })
  ).toThrow();
});

test('clearing a terminal native CLI provider session ref allows a managed resume to claim it', () => {
  store.upsertNativeCliSession({
    ...row,
    id: 'ncli_old',
    runtimeRole: 'managed-project-agent',
    state: 'stopped',
    pid: null,
    providerSessionRef: 'provider-thread-1',
    exitedAt: '2026-06-28T00:00:01.000Z'
  });

  expect(store.clearNativeCliSessionRef('ncli_old')).toBe(true);
  store.upsertNativeCliSession({ ...row, id: 'ncli_new', providerSessionRef: 'provider-thread-1' });

  expect(store.getNativeCliSession('ncli_old')?.providerSessionRef).toBeNull();
  expect(store.getNativeCliSession('ncli_new')?.providerSessionRef).toBe('provider-thread-1');
});

test('deleteSession cleans up native CLI session rows', () => {
  store.insertWorkplaceProject({
    id: 'prj_project',
    title: 'project',
    ownerPrincipalId: 'prn_test',
    state: 'active',
    archived: false,
    createdAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z'
  });
  store.upsertNativeCliSession(row);
  store.insertMessage('msg_cleanup', 'prj_project', 'cleanup', '2026-06-28T00:00:01.000Z', 'user');
  expect(store.enqueueNativeCliInboxItem('ncli_1', 1)).toBe(true);
  store.insertNativeAgentDirectMessage({
    id: 'msg_direct_cleanup',
    projectId: 'prj_project',
    nativeCliSessionId: 'ncli_1',
    fromAgent: 'codex',
    peer: 'claude',
    text: 'private',
    createdAt: '2026-06-28T00:00:02.000Z'
  });
  expect(store.listNativeAgentDirectMessages('ncli_1', 'claude')).toHaveLength(1);

  store.deleteWorkplaceProject('prj_project');

  expect(store.listNativeCliSessionsForTranscriptTarget('prj_project')).toHaveLength(0);

  store.insertWorkplaceProject({
    id: 'prj_project',
    title: 'project',
    ownerPrincipalId: 'prn_test',
    state: 'active',
    archived: false,
    createdAt: '2026-06-28T00:00:02.000Z',
    updatedAt: '2026-06-28T00:00:02.000Z'
  });
  store.upsertNativeCliSession(row);
  expect(store.enqueueNativeCliInboxItem('ncli_1', 1)).toBe(true);
  expect(store.listNativeAgentDirectMessages('ncli_1', 'claude')).toHaveLength(0);
});
