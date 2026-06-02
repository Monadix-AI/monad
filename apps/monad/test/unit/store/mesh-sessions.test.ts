import type { Event, MeshSessionId, ProjectId, Session, SessionId, WorkplaceProject } from '@monad/protocol';
import type { MeshSessionRow } from '#/store/db/index.ts';

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNativeAgentAttachmentReader } from '#/services/native-agent/attachments.ts';
import { createStore } from '#/store/db/index.ts';

let store: ReturnType<typeof createStore>;

beforeEach(() => {
  store = createStore();
});

afterEach(() => {
  store.close();
});

const row: MeshSessionRow = {
  id: 'mesh_100000000000',
  transcriptTargetId: 'ses_project00000',
  agentName: 'codex',
  provider: 'codex' as const,
  workingPath: '/tmp/project',
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

// Stamp a mesh session's canonical owner via the production path (ProjectMember + active SessionBinding +
// current runtime), so listNativeAgentDirectMessages resolves `$self` from projectMemberId, not fail-closed.
function ownMesh(meshId: string, sessionId: SessionId, projectMemberId: string): void {
  const at = '2026-06-28T00:00:00.000Z';
  const projectId = 'prj_meshowner001';
  store.insertWorkplaceProject({
    id: projectId,
    title: 'owner',
    state: 'active',
    archived: false,
    memberTemplates: [],
    createdAt: at,
    updatedAt: at
  });
  store.insertSession({
    id: sessionId,
    projectId,
    title: 'owner',
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    activityAt: at,
    createdAt: at,
    updatedAt: at
  } as Session);
  store.insertProjectMember({
    id: projectMemberId,
    projectId,
    profileId: 'codex',
    type: 'mesh-agent',
    displayName: 'Codex',
    customPrompt: null,
    launchOverrides: {},
    workingDirectoryOverride: null,
    lifecycle: 'enabled',
    createdAt: at,
    updatedAt: at
  });
  store.insertSessionBinding({
    sessionId,
    projectMemberId,
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    lifecycle: 'active',
    createdAt: at,
    updatedAt: at
  });
  store.replaceSessionBindingRuntime({
    sessionId,
    projectMemberId,
    currentNativeRuntimeSessionId: meshId as MeshSessionId,
    updatedAt: at
  });
}

test('MeshAgent session lifecycle stores provider mapping and exit status without observation output', () => {
  store.upsertMeshSession({ ...row, outputSnapshot: 'must not persist' });
  store.updateMeshSessionRef('mesh_100000000000', 'provider-session-1');
  store.closeMeshSession('mesh_100000000000', '2026-06-28T00:00:01.000Z', 0);

  const rows = store.listMeshSessionsForTranscriptTarget('ses_project00000');
  expect(rows).toHaveLength(1);
  expect(rows[0]?.outputSnapshot).toBe('');
  expect(rows[0]?.providerSessionRef).toBe('provider-session-1');
  expect(rows[0]?.state).toBe('exited');
  expect(rows[0]?.exitCode).toBe(0);
});

test('closeMeshSession does not overwrite terminal MeshAgent session state', () => {
  store.upsertMeshSession(row);
  store.closeMeshSession('mesh_100000000000', '2026-06-28T00:00:01.000Z', null, 'stopped');
  store.closeMeshSession('mesh_100000000000', '2026-06-28T00:00:02.000Z', 0, 'exited');

  const closed = store.getMeshSession('mesh_100000000000');
  expect(closed?.state).toBe('stopped');
  expect(closed?.exitedAt).toBe('2026-06-28T00:00:01.000Z');
});

test('reconcileOrphanedMeshSessions marks live MeshAgent rows stopped on daemon restart', () => {
  store.upsertMeshSession(row);
  store.upsertMeshSession({ ...row, id: 'mesh_starting0000', state: 'starting', pid: null });
  store.upsertMeshSession({
    ...row,
    id: 'mesh_done00000000',
    state: 'exited',
    pid: 456,
    exitedAt: row.updatedAt
  });

  const reconciled = store.reconcileOrphanedMeshSessions(() => {});

  expect(reconciled).toBe(2);
  expect(store.getMeshSession('mesh_100000000000')?.state).toBe('stopped');
  expect(store.getMeshSession('mesh_starting0000')?.state).toBe('stopped');
  expect(store.getMeshSession('mesh_done00000000')?.state).toBe('exited');
});

test('reconcileOrphanedMeshSessions preserves managed provider refs for later cold resume', () => {
  store.upsertMeshSession({
    ...row,
    id: 'mesh_managedruAQ3',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: 'mesh_managedruAQ3',
    agentRuntimeTokenHash: 'token-hash',
    providerSessionRef: 'provider-thread-1',
    lastDeliveredSeq: 10,
    lastVisibleSeq: 8
  });

  expect(store.reconcileOrphanedMeshSessions(() => {})).toBe(1);

  expect(store.getMeshSession('mesh_managedruAQ3')).toMatchObject({
    state: 'stopped',
    providerSessionRef: 'provider-thread-1',
    lastDeliveredSeq: 10,
    lastVisibleSeq: 8
  });
});

test('failOrphanedStreamingMessages retires empty managed MeshAgent thinking placeholders', () => {
  store.insertMessage('msg_thinking0000', 'ses_project00000', '', '2026-06-28T00:00:01.000Z', 'assistant', {
    data: {
      agentName: 'codex',
      meshSessionId: 'mesh_100000000000',
      reasoning: 'Thinking',
      source: 'managed-mesh-agent'
    },
    includeInContext: false,
    streamStatus: 'streaming'
  });

  expect(store.failOrphanedStreamingMessages('2026-06-28T00:00:02.000Z')).toBe(1);
});

test('MeshAgent inbox diagnostics count pending visible messages', () => {
  store.insertMessage('msg_100000000000', 'ses_project00000', 'seen', '2026-06-28T00:00:01.000Z', 'user');
  store.insertMessage('msg_200000000000', 'ses_project00000', 'pending one', '2026-06-28T00:00:02.000Z', 'user');
  store.insertMessage('msg_300000000000', 'ses_project00000', 'pending two', '2026-06-28T00:00:03.000Z', 'user');
  store.upsertMeshSession({ ...row, id: 'mesh_inboxdiag000', lastVisibleSeq: 1, lastDeliveredSeq: 3 });
  store.enqueueMeshAgentInboxItem('mesh_inboxdiag000', 2);
  store.enqueueMeshAgentInboxItem('mesh_inboxdiag000', 3);

  expect(store.countMeshAgentInbox('mesh_inboxdiag000')).toBe(2);
});

test('MeshAgent inbox diagnostics ignore inactive messages', () => {
  store.insertMessage('msg_100000000000', 'ses_project00000', 'pending one', '2026-06-28T00:00:01.000Z', 'user');
  store.insertMessage('msg_200000000000', 'ses_project00000', 'pending two', '2026-06-28T00:00:02.000Z', 'user');
  store.upsertMeshSession({ ...row, id: 'mesh_inboxdiag000', lastVisibleSeq: 0, lastDeliveredSeq: 2 });
  store.enqueueMeshAgentInboxItem('mesh_inboxdiag000', 1);
  store.enqueueMeshAgentInboxItem('mesh_inboxdiag000', 2);
  store.restoreMessages('ses_project00000', 'msg_200000000000');

  expect(store.countMeshAgentInbox('mesh_inboxdiag000')).toBe(1);
});

test('MeshAgent inbox only exposes messages explicitly queued for that runtime', () => {
  store.insertMessage('msg_100000000000', 'ses_project00000', 'unqueued', '2026-06-28T00:00:01.000Z', 'user');
  store.insertMessage('msg_200000000000', 'ses_project00000', 'queued', '2026-06-28T00:00:02.000Z', 'user');
  store.upsertMeshSession({ ...row, id: 'mesh_inboxdiag000', lastVisibleSeq: 0, lastDeliveredSeq: 0 });

  store.enqueueMeshAgentInboxItem('mesh_inboxdiag000', 2);

  expect(store.listMeshAgentInbox('mesh_inboxdiag000')).toEqual([
    expect.objectContaining({
      seq: 2,
      deliveryState: 'queued',
      message: expect.objectContaining({ id: 'msg_200000000000', text: 'queued' })
    })
  ]);
});

test('MeshAgent inbox delivery and visible cursors update queued item state', () => {
  store.insertMessage('msg_100000000000', 'ses_project00000', 'queued', '2026-06-28T00:00:01.000Z', 'user');
  store.upsertMeshSession({ ...row, id: 'mesh_inboxdiag000', lastVisibleSeq: 0, lastDeliveredSeq: 0 });
  store.enqueueMeshAgentInboxItem('mesh_inboxdiag000', 1);

  store.markMeshAgentInboxDelivered('mesh_inboxdiag000', 1);
  expect(store.listMeshAgentInbox('mesh_inboxdiag000')[0]?.deliveryState).toBe('delivered');

  store.markMeshAgentInboxVisible('mesh_inboxdiag000', 1);
  expect(store.getMeshSession('mesh_inboxdiag000')).toMatchObject({ lastDeliveredSeq: 1, lastVisibleSeq: 1 });
  expect(store.hasUnconsumedMeshAgentInbox('mesh_inboxdiag000')).toBe(true);

  store.markMeshAgentInboxConsumed('mesh_inboxdiag000', 1);
  expect(store.hasUnconsumedMeshAgentInbox('mesh_inboxdiag000')).toBe(false);
});

test('message attachments register a file reference snapshot, not content', () => {
  const ref = store.registerMessageAttachment({
    id: 'att_100000000000',
    sessionId: 'ses_project00000',
    path: '/tmp/project/report.md',
    name: 'report.md',
    mime: 'text/markdown',
    bytes: 12345,
    preview: 'long messag…',
    createdBy: 'codex',
    createdAt: '2026-06-28T00:00:01.000Z'
  });
  expect(ref).toEqual({
    id: 'att_100000000000',
    path: '/tmp/project/report.md',
    name: 'report.md',
    mime: 'text/markdown',
    bytes: 12345,
    createdAt: '2026-06-28T00:00:01.000Z'
  });

  const fetched = store.getMessageAttachment('att_100000000000');
  expect(fetched).toMatchObject({
    id: 'att_100000000000',
    sessionId: 'ses_project00000',
    path: '/tmp/project/report.md'
  });
});

test('message attachment reader rejects paths that changed after registration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monad-attachment-toctou-'));
  try {
    const workspace = join(dir, 'workspace');
    const outside = join(dir, 'outside.txt');
    const file = join(workspace, 'report.md');
    await mkdir(workspace, { recursive: true });
    await writeFile(outside, 'outside secret');
    await writeFile(file, 'inside report');
    store.registerMessageAttachment({
      id: 'att_100000000000',
      sessionId: 'ses_project00000',
      path: file,
      name: 'report.md',
      mime: 'text/markdown',
      bytes: 13,
      preview: 'inside report',
      createdBy: 'codex',
      createdAt: '2026-06-28T00:00:01.000Z'
    });
    await unlink(file);
    await symlink(outside, file);

    await expect(createNativeAgentAttachmentReader(store).read('att_100000000000', false)).rejects.toThrow(
      'attachment path changed after registration'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('native agent direct messages round-trip an attachment reference', () => {
  store.upsertMeshSession({ ...row, id: 'mesh_direct000000' });
  ownMesh('mesh_direct000000', 'ses_project00000', 'pmem_codex');
  const ref = store.registerMessageAttachment({
    id: 'att_100000000000',
    sessionId: 'ses_project00000',
    path: '/tmp/project/report.md',
    name: 'report.md',
    mime: 'text/markdown',
    bytes: 12345,
    preview: '',
    createdAt: '2026-06-28T00:00:00.000Z'
  });
  store.insertNativeAgentDirectMessage({
    id: 'msg_D10000000000',
    sessionId: 'ses_project00000',
    meshSessionId: 'mesh_direct000000',
    fromAgent: 'pmem_codex',
    peer: 'human',
    text: 'preview…',
    attachments: [ref],
    createdAt: '2026-06-28T00:00:01.000Z'
  });
  store.insertNativeAgentDirectMessage({
    id: 'msg_D20000000000',
    sessionId: 'ses_project00000',
    meshSessionId: 'mesh_direct000000',
    fromAgent: 'pmem_codex',
    peer: 'human',
    text: 'inline',
    createdAt: '2026-06-28T00:00:02.000Z'
  });

  const messages = store.listNativeAgentDirectMessages('mesh_direct000000', 'human');
  expect(messages[0]?.attachments).toEqual([ref]);
});

test('native agent direct message request identity replays the original row and rejects changed intent', () => {
  const message = {
    id: 'msg_D30000000000' as const,
    sessionId: 'ses_project00000' as const,
    meshSessionId: 'mesh_direct000000',
    fromAgent: 'codex',
    peer: 'human',
    text: 'private note',
    createdAt: '2026-06-28T00:00:03.000Z'
  };

  expect(
    store.insertNativeAgentDirectMessage(message, {
      requestId: 'direct-request-1',
      requestFingerprint: 'fingerprint-1'
    })
  ).toEqual({ message, replayed: false });
  expect(
    store.insertNativeAgentDirectMessage(
      { ...message, id: 'msg_D40000000000', createdAt: '2026-06-28T00:00:04.000Z' },
      { requestId: 'direct-request-1', requestFingerprint: 'fingerprint-1' }
    )
  ).toEqual({ message, replayed: true });
  expect(() =>
    store.insertNativeAgentDirectMessage(
      { ...message, id: 'msg_D50000000000', text: 'changed', createdAt: '2026-06-28T00:00:05.000Z' },
      { requestId: 'direct-request-1', requestFingerprint: 'fingerprint-2' }
    )
  ).toThrow('idempotency key reused with a different command');
});

test('provider session refs are unique per project session and provider when present', () => {
  store.upsertMeshSession({ ...row, id: 'mesh_100000000000', providerSessionRef: 'provider-thread-1' });
  store.upsertMeshSession({ ...row, id: 'mesh_200000000000', providerSessionRef: null });
  store.upsertMeshSession({ ...row, id: 'mesh_300000000000', providerSessionRef: null });
  store.upsertMeshSession({
    ...row,
    id: 'mesh_otherproject',
    transcriptTargetId: 'ses_other0000000',
    providerSessionRef: 'provider-thread-1'
  });
  store.upsertMeshSession({
    ...row,
    id: 'mesh_otherproUZGI',
    provider: 'claude-code',
    providerSessionRef: 'provider-thread-1'
  });

  expect(() =>
    store.upsertMeshSession({ ...row, id: 'mesh_duplicate000', providerSessionRef: 'provider-thread-1' })
  ).toThrow();
});

test('clearing a terminal MeshAgent provider session ref allows a managed resume to claim it', () => {
  store.upsertMeshSession({
    ...row,
    id: 'mesh_old000000000',
    runtimeRole: 'managed-project-agent',
    state: 'stopped',
    pid: null,
    providerSessionRef: 'provider-thread-1',
    exitedAt: '2026-06-28T00:00:01.000Z'
  });

  expect(store.clearMeshSessionRef('mesh_old000000000')).toBe(true);
  store.upsertMeshSession({ ...row, id: 'mesh_new000000000', providerSessionRef: 'provider-thread-1' });

  expect(store.getMeshSession('mesh_new000000000')?.providerSessionRef).toBe('provider-thread-1');
});

test('MeshAgent inbox items expose delivery pointers without raw provider output', () => {
  store.upsertMeshSession({
    ...row,
    transcriptTargetId: 'ses_01KPROJEIdZ2',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: 'mesh_100000000000',
    providerSessionRef: 'provider-session-1',
    outputSnapshot: '{"raw":"provider output"}'
  });
  // A managed runtime is owned by a ProjectMember with an active SessionBinding — inbox reads resolve the
  // binding watermark, so the fixture must establish that ownership.
  const at = '2026-06-28T00:00:00.000Z';
  store.insertWorkplaceProject({
    id: 'prj_01KPROJE0001',
    title: 'Delivery pointers',
    state: 'active',
    archived: false,
    memberTemplates: [],
    createdAt: at,
    updatedAt: at
  });
  store.insertSession({
    id: 'ses_01KPROJEIdZ2',
    projectId: 'prj_01KPROJE0001',
    title: 'Delivery pointers',
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    activityAt: at,
    createdAt: at,
    updatedAt: at
  } as Session);
  store.insertProjectMember({
    id: 'pmem_codex_1',
    projectId: 'prj_01KPROJE0001',
    profileId: 'codex',
    type: 'mesh-agent',
    displayName: 'Codex',
    customPrompt: null,
    launchOverrides: {},
    workingDirectoryOverride: null,
    lifecycle: 'enabled',
    createdAt: at,
    updatedAt: at
  });
  store.insertSessionBinding({
    sessionId: 'ses_01KPROJEIdZ2',
    projectMemberId: 'pmem_codex_1',
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    lifecycle: 'active',
    createdAt: at,
    updatedAt: at
  });
  store.replaceSessionBindingRuntime({
    sessionId: 'ses_01KPROJEIdZ2',
    projectMemberId: 'pmem_codex_1',
    currentNativeRuntimeSessionId: 'mesh_100000000000',
    updatedAt: at
  });
  store.insertMessage('msg_01KDELIVumHr', 'ses_01KPROJEIdZ2', 'hi', '2026-06-28T00:00:01.000Z', 'user');

  expect(
    store.enqueueMeshAgentInboxItem('mesh_100000000000', 1, {
      deliveryId: 'deliv_01KDELIV8OEg',
      projectId: 'ses_01KPROJEIdZ2' as ProjectId,
      memberInstanceId: 'pmem_codex_1',
      triggerMessageId: 'msg_01KDELIVumHr',
      providerSessionRef: 'provider-session-1',
      providerTurnId: 'turn-1',
      createdAt: '2026-06-28T00:00:02.000Z'
    })
  ).toBe(true);

  const [item] = store.listMeshAgentInbox('mesh_100000000000');
  const delivery = store.getNativeAgentDelivery('deliv_01KDELIV8OEg');

  expect(item?.deliveryId).toBe('deliv_01KDELIV8OEg');
  expect(delivery).toMatchObject({
    id: 'deliv_01KDELIV8OEg',
    sessionId: 'ses_01KPROJEIdZ2',
    memberInstanceId: 'pmem_codex_1',
    meshSessionId: 'mesh_100000000000',
    triggerMessageId: 'msg_01KDELIVumHr',
    triggerMessageSeq: 1,
    state: 'queued',
    turn: { providerSessionRef: 'provider-session-1', providerTurnId: 'turn-1' }
  });
});

test('operator inbox aggregates agent mentions and unresolved approvals', () => {
  const project: WorkplaceProject = {
    id: 'prj_ABCDEF123456',
    title: 'Inbox Project',
    state: 'active',
    archived: false,
    memberTemplates: [],
    createdAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z'
  };
  const session: Session = {
    id: 'ses_ABCDEF123456',
    projectId: project.id,
    title: 'Mention Thread',
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0
    },
    costUsd: 0,
    createdAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z'
  };

  store.insertWorkplaceProject(project);
  store.insertSession(session);
  store.insertSessionMember({
    sessionId: session.id,
    memberId: 'pmem_codex_1',
    templateId: 'pmem_codex_1',
    type: 'mesh-agent',
    data: { name: 'codex', displayName: 'Lily' },
    createdAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z'
  });
  store.insertMessage(
    'msg_ABCDEF123450',
    session.id,
    '@[name="zeke" id="human"] please review',
    '2026-06-28T00:00:01.000Z',
    'assistant',
    { data: { agentName: 'pmem_codex_1', source: 'managed-mesh-agent' } }
  );
  store.insertMessage('msg_ABCDEF123451', session.id, 'ordinary agent reply', '2026-06-28T00:00:02.000Z', 'assistant');
  store.appendEvents([
    {
      id: 'evt_ABCDEF123450',
      sessionId: session.id,
      type: 'tool.approval_requested',
      actorAgentId: null,
      payload: { requestId: 'req_ABCDEF123450', tool: 'shell_exec', input: { command: 'git status' } },
      at: '2026-06-28T00:00:03.000Z'
    } as Event,
    {
      id: 'evt_ABCDEF123451',
      sessionId: session.id,
      type: 'mesh.approval_requested',
      actorAgentId: null,
      payload: {
        requestId: 'req_ABCDEF123451',
        meshSessionId: 'mesh_ABCDEF123456',
        provider: 'codex',
        text: 'Allow command?',
        data: { command: 'bun test' }
      },
      at: '2026-06-28T00:00:04.000Z'
    } as Event,
    {
      id: 'evt_ABCDEF123452',
      sessionId: session.id,
      type: 'tool.approval_requested',
      actorAgentId: null,
      payload: { requestId: 'req_ABCDEF123452', tool: 'file_write', input: { path: '/tmp/done' } },
      at: '2026-06-28T00:00:05.000Z'
    } as Event,
    {
      id: 'evt_ABCDEF123453',
      sessionId: session.id,
      type: 'tool.approval_resolved',
      actorAgentId: null,
      payload: { requestId: 'req_ABCDEF123452', tool: 'file_write', allow: true },
      at: '2026-06-28T00:00:06.000Z'
    } as Event
  ]);

  const items = store.listMentionInbox();
  expect(items).toEqual([
    expect.objectContaining({
      kind: 'approval',
      id: 'req_ABCDEF123451',
      approvalKind: 'mesh-agent',
      projectId: project.id,
      sessionId: session.id,
      meshSessionId: 'mesh_ABCDEF123456'
    }),
    expect.objectContaining({
      kind: 'approval',
      id: 'req_ABCDEF123450',
      approvalKind: 'tool',
      projectId: project.id,
      sessionId: session.id,
      tool: 'shell_exec'
    }),
    expect.objectContaining({
      kind: 'mention',
      id: 'msg_ABCDEF123450',
      projectId: project.id,
      sessionId: session.id,
      agentName: 'Lily',
      message: expect.objectContaining({ id: 'msg_ABCDEF123450', text: '@[name="zeke" id="human"] please review' })
    })
  ]);
  expect(items.some((item) => item.id === 'req_ABCDEF123452')).toBe(false);
});

test('deleteSession cleans up MeshAgent session rows', () => {
  store.upsertMeshSession(row);
  ownMesh('mesh_100000000000', 'ses_project00000', 'pmem_codex');
  store.insertMessage('msg_cleanup00000', 'ses_project00000', 'cleanup', '2026-06-28T00:00:01.000Z', 'user');
  expect(store.enqueueMeshAgentInboxItem('mesh_100000000000', 1)).toBe(true);
  store.insertNativeAgentDirectMessage({
    id: 'msg_directclJJjb',
    sessionId: 'ses_project00000',
    meshSessionId: 'mesh_100000000000',
    fromAgent: 'pmem_codex',
    peer: 'claude',
    text: 'private',
    createdAt: '2026-06-28T00:00:02.000Z'
  });
  // presence-ok: a stored DM is listed for the conversation, then absent after deleteSession purges it below
  expect(store.listNativeAgentDirectMessages('mesh_100000000000', 'claude')).toHaveLength(1);

  store.deleteSession('ses_project00000');

  store.upsertMeshSession(row);
  expect(store.enqueueMeshAgentInboxItem('mesh_100000000000', 1)).toBe(true);
});
