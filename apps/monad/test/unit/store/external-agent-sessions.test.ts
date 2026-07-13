import type { Event, ProjectId, Session, WorkplaceProject } from '@monad/protocol';
import type { ExternalAgentSessionRow } from '#/store/db/index.ts';

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

const row: ExternalAgentSessionRow = {
  id: 'exa_100000000000',
  transcriptTargetId: 'ses_project00000',
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

test('external agent session lifecycle stores output snapshots and exit status', () => {
  store.upsertExternalAgentSession(row);
  store.appendExternalAgentOutput('exa_100000000000', 'hello', 32);
  store.updateExternalAgentSessionRef('exa_100000000000', 'provider-session-1');
  store.closeExternalAgentSession('exa_100000000000', '2026-06-28T00:00:01.000Z', 0);

  const rows = store.listExternalAgentSessionsForTranscriptTarget('ses_project00000');
  expect(rows).toHaveLength(1);
  expect(rows[0]?.outputSnapshot).toBe('hello');
  expect(rows[0]?.providerSessionRef).toBe('provider-session-1');
  expect(rows[0]?.state).toBe('exited');
  expect(rows[0]?.exitCode).toBe(0);
});

test('closeExternalAgentSession does not overwrite terminal external agent session state', () => {
  store.upsertExternalAgentSession(row);
  store.closeExternalAgentSession('exa_100000000000', '2026-06-28T00:00:01.000Z', null, 'stopped');
  store.closeExternalAgentSession('exa_100000000000', '2026-06-28T00:00:02.000Z', 0, 'exited');

  const closed = store.getExternalAgentSession('exa_100000000000');
  expect(closed?.state).toBe('stopped');
  expect(closed?.exitedAt).toBe('2026-06-28T00:00:01.000Z');
});

test('reconcileOrphanedExternalAgentSessions marks live external agent rows stopped on daemon restart', () => {
  store.upsertExternalAgentSession(row);
  store.upsertExternalAgentSession({ ...row, id: 'exa_starting0000', state: 'starting', pid: null });
  store.upsertExternalAgentSession({
    ...row,
    id: 'exa_done00000000',
    state: 'exited',
    pid: 456,
    exitedAt: row.updatedAt
  });

  const reconciled = store.reconcileOrphanedExternalAgentSessions(() => {});

  expect(reconciled).toBe(2);
  expect(store.getExternalAgentSession('exa_100000000000')?.state).toBe('stopped');
  expect(store.getExternalAgentSession('exa_starting0000')?.state).toBe('stopped');
  expect(store.getExternalAgentSession('exa_done00000000')?.state).toBe('exited');
});

test('reconcileOrphanedExternalAgentSessions preserves managed provider refs for later cold resume', () => {
  store.upsertExternalAgentSession({
    ...row,
    id: 'exa_managedruAQ3',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: 'exa_managedruAQ3',
    agentRuntimeTokenHash: 'token-hash',
    providerSessionRef: 'provider-thread-1',
    lastDeliveredSeq: 10,
    lastVisibleSeq: 8
  });

  expect(store.reconcileOrphanedExternalAgentSessions(() => {})).toBe(1);

  expect(store.getExternalAgentSession('exa_managedruAQ3')).toMatchObject({
    state: 'stopped',
    providerSessionRef: 'provider-thread-1',
    lastDeliveredSeq: 10,
    lastVisibleSeq: 8
  });
});

test('failOrphanedStreamingMessages retires empty managed external agent thinking placeholders', () => {
  store.insertMessage('msg_thinking0000', 'ses_project00000', '', '2026-06-28T00:00:01.000Z', 'assistant', {
    data: {
      agentName: 'codex',
      externalAgentSessionId: 'exa_100000000000',
      reasoning: 'Thinking',
      source: 'managed-external-agent'
    },
    includeInContext: false,
    streamStatus: 'streaming'
  });

  expect(store.failOrphanedStreamingMessages('2026-06-28T00:00:02.000Z')).toBe(1);
});

test('external agent inbox diagnostics count pending visible messages', () => {
  store.insertMessage('msg_100000000000', 'ses_project00000', 'seen', '2026-06-28T00:00:01.000Z', 'user');
  store.insertMessage('msg_200000000000', 'ses_project00000', 'pending one', '2026-06-28T00:00:02.000Z', 'user');
  store.insertMessage('msg_300000000000', 'ses_project00000', 'pending two', '2026-06-28T00:00:03.000Z', 'user');
  store.upsertExternalAgentSession({ ...row, id: 'exa_inboxdiag000', lastVisibleSeq: 1, lastDeliveredSeq: 3 });
  store.enqueueExternalAgentInboxItem('exa_inboxdiag000', 2);
  store.enqueueExternalAgentInboxItem('exa_inboxdiag000', 3);

  expect(store.countExternalAgentInbox('exa_inboxdiag000')).toBe(2);
});

test('external agent inbox diagnostics ignore inactive messages', () => {
  store.insertMessage('msg_100000000000', 'ses_project00000', 'pending one', '2026-06-28T00:00:01.000Z', 'user');
  store.insertMessage('msg_200000000000', 'ses_project00000', 'pending two', '2026-06-28T00:00:02.000Z', 'user');
  store.upsertExternalAgentSession({ ...row, id: 'exa_inboxdiag000', lastVisibleSeq: 0, lastDeliveredSeq: 2 });
  store.enqueueExternalAgentInboxItem('exa_inboxdiag000', 1);
  store.enqueueExternalAgentInboxItem('exa_inboxdiag000', 2);
  store.restoreMessages('ses_project00000', 'msg_200000000000');

  expect(store.countExternalAgentInbox('exa_inboxdiag000')).toBe(1);
});

test('external agent inbox only exposes messages explicitly queued for that runtime', () => {
  store.insertMessage('msg_100000000000', 'ses_project00000', 'unqueued', '2026-06-28T00:00:01.000Z', 'user');
  store.insertMessage('msg_200000000000', 'ses_project00000', 'queued', '2026-06-28T00:00:02.000Z', 'user');
  store.upsertExternalAgentSession({ ...row, id: 'exa_inboxdiag000', lastVisibleSeq: 0, lastDeliveredSeq: 0 });

  store.enqueueExternalAgentInboxItem('exa_inboxdiag000', 2);

  expect(store.listExternalAgentInbox('exa_inboxdiag000')).toEqual([
    expect.objectContaining({
      seq: 2,
      deliveryState: 'queued',
      message: expect.objectContaining({ id: 'msg_200000000000', text: 'queued' })
    })
  ]);
});

test('external agent inbox delivery and visible cursors update queued item state', () => {
  store.insertMessage('msg_100000000000', 'ses_project00000', 'queued', '2026-06-28T00:00:01.000Z', 'user');
  store.upsertExternalAgentSession({ ...row, id: 'exa_inboxdiag000', lastVisibleSeq: 0, lastDeliveredSeq: 0 });
  store.enqueueExternalAgentInboxItem('exa_inboxdiag000', 1);

  store.markExternalAgentInboxDelivered('exa_inboxdiag000', 1);
  expect(store.listExternalAgentInbox('exa_inboxdiag000')[0]?.deliveryState).toBe('delivered');

  store.markExternalAgentInboxVisible('exa_inboxdiag000', 1);
  expect(store.getExternalAgentSession('exa_inboxdiag000')).toMatchObject({ lastDeliveredSeq: 1, lastVisibleSeq: 1 });
  expect(store.hasUnconsumedExternalAgentInbox('exa_inboxdiag000')).toBe(true);

  store.markExternalAgentInboxConsumed('exa_inboxdiag000', 1);
  expect(store.hasUnconsumedExternalAgentInbox('exa_inboxdiag000')).toBe(false);
});

test('message attachments register a file reference snapshot, not content', () => {
  const ref = store.registerMessageAttachment({
    id: 'att_100000000000',
    projectId: 'ses_project00000',
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
    projectId: 'ses_project00000',
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
      projectId: 'ses_project00000',
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

    await expect(
      createNativeAgentAttachmentReader(store, ({ workingPath }) => (workingPath ? [workingPath] : [])).read(
        'att_100000000000',
        false
      )
    ).rejects.toThrow('attachment path changed after registration');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('native agent direct messages round-trip an attachment reference', () => {
  store.upsertExternalAgentSession({ ...row, id: 'exa_direct000000' });
  const ref = store.registerMessageAttachment({
    id: 'att_100000000000',
    projectId: 'ses_project00000',
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
    externalAgentSessionId: 'exa_direct000000',
    fromAgent: 'codex',
    peer: 'human',
    text: 'preview…',
    attachments: [ref],
    createdAt: '2026-06-28T00:00:01.000Z'
  });
  store.insertNativeAgentDirectMessage({
    id: 'msg_D20000000000',
    sessionId: 'ses_project00000',
    externalAgentSessionId: 'exa_direct000000',
    fromAgent: 'codex',
    peer: 'human',
    text: 'inline',
    createdAt: '2026-06-28T00:00:02.000Z'
  });

  const messages = store.listNativeAgentDirectMessages('exa_direct000000', 'human');
  expect(messages[0]?.attachments).toEqual([ref]);
});

test('provider session refs are unique per project session and provider when present', () => {
  store.upsertExternalAgentSession({ ...row, id: 'exa_100000000000', providerSessionRef: 'provider-thread-1' });
  store.upsertExternalAgentSession({ ...row, id: 'exa_200000000000', providerSessionRef: null });
  store.upsertExternalAgentSession({ ...row, id: 'exa_300000000000', providerSessionRef: null });
  store.upsertExternalAgentSession({
    ...row,
    id: 'exa_otherproject',
    transcriptTargetId: 'ses_other0000000',
    providerSessionRef: 'provider-thread-1'
  });
  store.upsertExternalAgentSession({
    ...row,
    id: 'exa_otherproUZGI',
    provider: 'claude-code',
    providerSessionRef: 'provider-thread-1'
  });

  expect(() =>
    store.upsertExternalAgentSession({ ...row, id: 'exa_duplicate000', providerSessionRef: 'provider-thread-1' })
  ).toThrow();
});

test('clearing a terminal external agent provider session ref allows a managed resume to claim it', () => {
  store.upsertExternalAgentSession({
    ...row,
    id: 'exa_old000000000',
    runtimeRole: 'managed-project-agent',
    state: 'stopped',
    pid: null,
    providerSessionRef: 'provider-thread-1',
    exitedAt: '2026-06-28T00:00:01.000Z'
  });

  expect(store.clearExternalAgentSessionRef('exa_old000000000')).toBe(true);
  store.upsertExternalAgentSession({ ...row, id: 'exa_new000000000', providerSessionRef: 'provider-thread-1' });

  expect(store.getExternalAgentSession('exa_new000000000')?.providerSessionRef).toBe('provider-thread-1');
});

test('external agent inbox items expose delivery pointers without raw provider output', () => {
  store.upsertExternalAgentSession({
    ...row,
    transcriptTargetId: 'ses_01KPROJEIdZ2',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: 'exa_100000000000',
    providerSessionRef: 'provider-session-1',
    outputSnapshot: '{"raw":"provider output"}'
  });
  store.insertMessage('msg_01KDELIVumHr', 'ses_01KPROJEIdZ2', 'hi', '2026-06-28T00:00:01.000Z', 'user');

  expect(
    store.enqueueExternalAgentInboxItem('exa_100000000000', 1, {
      deliveryId: 'deliv_01KDELIV8OEg',
      projectId: 'ses_01KPROJEIdZ2' as ProjectId,
      memberInstanceId: 'pmem_codex_1',
      triggerMessageId: 'msg_01KDELIVumHr',
      providerSessionRef: 'provider-session-1',
      providerTurnId: 'turn-1',
      createdAt: '2026-06-28T00:00:02.000Z'
    })
  ).toBe(true);

  const [item] = store.listExternalAgentInbox('exa_100000000000');
  const delivery = store.getNativeAgentDelivery('deliv_01KDELIV8OEg');

  expect(item?.deliveryId).toBe('deliv_01KDELIV8OEg');
  expect(delivery).toMatchObject({
    id: 'deliv_01KDELIV8OEg',
    sessionId: 'ses_01KPROJEIdZ2',
    memberInstanceId: 'pmem_codex_1',
    externalAgentSessionId: 'exa_100000000000',
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
    ownerPrincipalId: 'prn_ABCDEF123456',
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
    ownerPrincipalId: 'prn_ABCDEF123456',
    state: 'active',
    agentIds: [],
    parentSessionId: null,
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
    type: 'external-agent',
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
    { data: { agentName: 'pmem_codex_1', source: 'managed-external-agent' } }
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
      type: 'external_agent.approval_requested',
      actorAgentId: null,
      payload: {
        requestId: 'req_ABCDEF123451',
        externalAgentSessionId: 'exa_ABCDEF123456',
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
      approvalKind: 'external-agent',
      projectId: project.id,
      sessionId: session.id,
      externalAgentSessionId: 'exa_ABCDEF123456'
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

test('deleteSession cleans up external agent session rows', () => {
  store.upsertExternalAgentSession(row);
  store.insertMessage('msg_cleanup00000', 'ses_project00000', 'cleanup', '2026-06-28T00:00:01.000Z', 'user');
  expect(store.enqueueExternalAgentInboxItem('exa_100000000000', 1)).toBe(true);
  store.insertNativeAgentDirectMessage({
    id: 'msg_directclJJjb',
    sessionId: 'ses_project00000',
    externalAgentSessionId: 'exa_100000000000',
    fromAgent: 'codex',
    peer: 'claude',
    text: 'private',
    createdAt: '2026-06-28T00:00:02.000Z'
  });
  expect(store.listNativeAgentDirectMessages('exa_100000000000', 'claude')).toHaveLength(1);

  store.deleteWorkplaceProject('ses_project00000');

  store.upsertExternalAgentSession(row);
  expect(store.enqueueExternalAgentInboxItem('exa_100000000000', 1)).toBe(true);
});
