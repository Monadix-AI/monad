import type { ProjectId } from '@monad/protocol';
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
  id: 'exa_1',
  transcriptTargetId: 'ses_project',
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
  store.appendExternalAgentOutput('exa_1', 'hello', 32);
  store.updateExternalAgentSessionRef('exa_1', 'provider-session-1');
  store.closeExternalAgentSession('exa_1', '2026-06-28T00:00:01.000Z', 0);

  const rows = store.listExternalAgentSessionsForTranscriptTarget('ses_project');
  expect(rows).toHaveLength(1);
  expect(rows[0]?.outputSnapshot).toBe('hello');
  expect(rows[0]?.providerSessionRef).toBe('provider-session-1');
  expect(rows[0]?.state).toBe('exited');
  expect(rows[0]?.exitCode).toBe(0);
});

test('closeExternalAgentSession does not overwrite terminal external agent session state', () => {
  store.upsertExternalAgentSession(row);
  store.closeExternalAgentSession('exa_1', '2026-06-28T00:00:01.000Z', null, 'stopped');
  store.closeExternalAgentSession('exa_1', '2026-06-28T00:00:02.000Z', 0, 'exited');

  const closed = store.getExternalAgentSession('exa_1');
  expect(closed?.state).toBe('stopped');
  expect(closed?.exitedAt).toBe('2026-06-28T00:00:01.000Z');
});

test('reconcileOrphanedExternalAgentSessions marks live external agent rows stopped on daemon restart', () => {
  store.upsertExternalAgentSession(row);
  store.upsertExternalAgentSession({ ...row, id: 'exa_starting', state: 'starting', pid: null });
  store.upsertExternalAgentSession({ ...row, id: 'exa_done', state: 'exited', pid: 456, exitedAt: row.updatedAt });

  const reconciled = store.reconcileOrphanedExternalAgentSessions(() => {});

  expect(reconciled).toBe(2);
  expect(store.getExternalAgentSession('exa_1')?.state).toBe('stopped');
  expect(store.getExternalAgentSession('exa_starting')?.state).toBe('stopped');
  expect(store.getExternalAgentSession('exa_done')?.state).toBe('exited');
});

test('reconcileOrphanedExternalAgentSessions preserves managed provider refs for later cold resume', () => {
  store.upsertExternalAgentSession({
    ...row,
    id: 'exa_managed_running',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: 'exa_managed_running',
    agentRuntimeTokenHash: 'token-hash',
    providerSessionRef: 'provider-thread-1',
    lastDeliveredSeq: 10,
    lastVisibleSeq: 8
  });

  expect(store.reconcileOrphanedExternalAgentSessions(() => {})).toBe(1);

  expect(store.getExternalAgentSession('exa_managed_running')).toMatchObject({
    state: 'stopped',
    providerSessionRef: 'provider-thread-1',
    lastDeliveredSeq: 10,
    lastVisibleSeq: 8
  });
});

test('failOrphanedStreamingMessages retires empty managed external agent thinking placeholders', () => {
  store.insertMessage('msg_thinking', 'ses_project', '', '2026-06-28T00:00:01.000Z', 'assistant', {
    data: {
      agentName: 'codex',
      externalAgentSessionId: 'exa_1',
      reasoning: 'Thinking',
      source: 'managed-external-agent'
    },
    includeInContext: false,
    streamStatus: 'streaming'
  });

  expect(store.failOrphanedStreamingMessages('2026-06-28T00:00:02.000Z')).toBe(1);
});

test('external agent inbox diagnostics count pending visible messages', () => {
  store.insertMessage('msg_1', 'ses_project', 'seen', '2026-06-28T00:00:01.000Z', 'user');
  store.insertMessage('msg_2', 'ses_project', 'pending one', '2026-06-28T00:00:02.000Z', 'user');
  store.insertMessage('msg_3', 'ses_project', 'pending two', '2026-06-28T00:00:03.000Z', 'user');
  store.upsertExternalAgentSession({ ...row, id: 'exa_inbox_diag', lastVisibleSeq: 1, lastDeliveredSeq: 3 });
  store.enqueueExternalAgentInboxItem('exa_inbox_diag', 2);
  store.enqueueExternalAgentInboxItem('exa_inbox_diag', 3);

  expect(store.countExternalAgentInbox('exa_inbox_diag')).toBe(2);
});

test('external agent inbox diagnostics ignore inactive messages', () => {
  store.insertMessage('msg_1', 'ses_project', 'pending one', '2026-06-28T00:00:01.000Z', 'user');
  store.insertMessage('msg_2', 'ses_project', 'pending two', '2026-06-28T00:00:02.000Z', 'user');
  store.upsertExternalAgentSession({ ...row, id: 'exa_inbox_diag', lastVisibleSeq: 0, lastDeliveredSeq: 2 });
  store.enqueueExternalAgentInboxItem('exa_inbox_diag', 1);
  store.enqueueExternalAgentInboxItem('exa_inbox_diag', 2);
  store.restoreMessages('ses_project', 'msg_2');

  expect(store.countExternalAgentInbox('exa_inbox_diag')).toBe(1);
});

test('external agent inbox only exposes messages explicitly queued for that runtime', () => {
  store.insertMessage('msg_1', 'ses_project', 'unqueued', '2026-06-28T00:00:01.000Z', 'user');
  store.insertMessage('msg_2', 'ses_project', 'queued', '2026-06-28T00:00:02.000Z', 'user');
  store.upsertExternalAgentSession({ ...row, id: 'exa_inbox_diag', lastVisibleSeq: 0, lastDeliveredSeq: 0 });

  store.enqueueExternalAgentInboxItem('exa_inbox_diag', 2);

  expect(store.listExternalAgentInbox('exa_inbox_diag')).toEqual([
    expect.objectContaining({
      seq: 2,
      deliveryState: 'queued',
      message: expect.objectContaining({ id: 'msg_2', text: 'queued' })
    })
  ]);
});

test('external agent inbox delivery and visible cursors update queued item state', () => {
  store.insertMessage('msg_1', 'ses_project', 'queued', '2026-06-28T00:00:01.000Z', 'user');
  store.upsertExternalAgentSession({ ...row, id: 'exa_inbox_diag', lastVisibleSeq: 0, lastDeliveredSeq: 0 });
  store.enqueueExternalAgentInboxItem('exa_inbox_diag', 1);

  store.markExternalAgentInboxDelivered('exa_inbox_diag', 1);
  expect(store.listExternalAgentInbox('exa_inbox_diag')[0]?.deliveryState).toBe('delivered');

  store.markExternalAgentInboxVisible('exa_inbox_diag', 1);
  expect(store.getExternalAgentSession('exa_inbox_diag')).toMatchObject({ lastDeliveredSeq: 1, lastVisibleSeq: 1 });
  expect(store.hasUnconsumedExternalAgentInbox('exa_inbox_diag')).toBe(true);

  store.markExternalAgentInboxConsumed('exa_inbox_diag', 1);
  expect(store.hasUnconsumedExternalAgentInbox('exa_inbox_diag')).toBe(false);
});

test('message attachments register a file reference snapshot, not content', () => {
  const ref = store.registerMessageAttachment({
    id: 'att_1',
    projectId: 'ses_project',
    path: '/tmp/project/report.md',
    name: 'report.md',
    mime: 'text/markdown',
    bytes: 12345,
    preview: 'long messag…',
    createdBy: 'codex',
    createdAt: '2026-06-28T00:00:01.000Z'
  });
  expect(ref).toEqual({
    id: 'att_1',
    path: '/tmp/project/report.md',
    name: 'report.md',
    mime: 'text/markdown',
    bytes: 12345,
    createdAt: '2026-06-28T00:00:01.000Z'
  });

  const fetched = store.getMessageAttachment('att_1');
  expect(fetched).toMatchObject({ id: 'att_1', projectId: 'ses_project', path: '/tmp/project/report.md' });
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
      id: 'att_1',
      projectId: 'ses_project',
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
        'att_1',
        false
      )
    ).rejects.toThrow('attachment path changed after registration');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('native agent direct messages round-trip an attachment reference', () => {
  store.upsertExternalAgentSession({ ...row, id: 'exa_direct' });
  const ref = store.registerMessageAttachment({
    id: 'att_1',
    projectId: 'ses_project',
    path: '/tmp/project/report.md',
    name: 'report.md',
    mime: 'text/markdown',
    bytes: 12345,
    preview: '',
    createdAt: '2026-06-28T00:00:00.000Z'
  });
  store.insertNativeAgentDirectMessage({
    id: 'msg_D1',
    sessionId: 'ses_project',
    externalAgentSessionId: 'exa_direct',
    fromAgent: 'codex',
    peer: 'human',
    text: 'preview…',
    attachments: [ref],
    createdAt: '2026-06-28T00:00:01.000Z'
  });
  store.insertNativeAgentDirectMessage({
    id: 'msg_D2',
    sessionId: 'ses_project',
    externalAgentSessionId: 'exa_direct',
    fromAgent: 'codex',
    peer: 'human',
    text: 'inline',
    createdAt: '2026-06-28T00:00:02.000Z'
  });

  const messages = store.listNativeAgentDirectMessages('exa_direct', 'human');
  expect(messages[0]?.attachments).toEqual([ref]);
});

test('provider session refs are unique per project session and provider when present', () => {
  store.upsertExternalAgentSession({ ...row, id: 'exa_1', providerSessionRef: 'provider-thread-1' });
  store.upsertExternalAgentSession({ ...row, id: 'exa_2', providerSessionRef: null });
  store.upsertExternalAgentSession({ ...row, id: 'exa_3', providerSessionRef: null });
  store.upsertExternalAgentSession({
    ...row,
    id: 'exa_other_project',
    transcriptTargetId: 'ses_other',
    providerSessionRef: 'provider-thread-1'
  });
  store.upsertExternalAgentSession({
    ...row,
    id: 'exa_other_provider',
    provider: 'claude-code',
    providerSessionRef: 'provider-thread-1'
  });

  expect(() =>
    store.upsertExternalAgentSession({ ...row, id: 'exa_duplicate', providerSessionRef: 'provider-thread-1' })
  ).toThrow();
});

test('clearing a terminal external agent provider session ref allows a managed resume to claim it', () => {
  store.upsertExternalAgentSession({
    ...row,
    id: 'exa_old',
    runtimeRole: 'managed-project-agent',
    state: 'stopped',
    pid: null,
    providerSessionRef: 'provider-thread-1',
    exitedAt: '2026-06-28T00:00:01.000Z'
  });

  expect(store.clearExternalAgentSessionRef('exa_old')).toBe(true);
  store.upsertExternalAgentSession({ ...row, id: 'exa_new', providerSessionRef: 'provider-thread-1' });

  expect(store.getExternalAgentSession('exa_new')?.providerSessionRef).toBe('provider-thread-1');
});

test('external agent inbox items expose delivery pointers without raw provider output', () => {
  store.upsertExternalAgentSession({
    ...row,
    transcriptTargetId: 'ses_01KPROJECTDELIVERY000000000',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: 'exa_1',
    providerSessionRef: 'provider-session-1',
    outputSnapshot: '{"raw":"provider output"}'
  });
  store.insertMessage(
    'msg_01KDELIVERYTRIGGER00000000',
    'ses_01KPROJECTDELIVERY000000000',
    'hi',
    '2026-06-28T00:00:01.000Z',
    'user'
  );

  expect(
    store.enqueueExternalAgentInboxItem('exa_1', 1, {
      deliveryId: 'deliv_01KDELIVERYTEST0000000000',
      projectId: 'ses_01KPROJECTDELIVERY000000000' as ProjectId,
      memberInstanceId: 'pmem_codex_1',
      triggerMessageId: 'msg_01KDELIVERYTRIGGER00000000',
      providerSessionRef: 'provider-session-1',
      providerTurnId: 'turn-1',
      createdAt: '2026-06-28T00:00:02.000Z'
    })
  ).toBe(true);

  const [item] = store.listExternalAgentInbox('exa_1');
  const delivery = store.getNativeAgentDelivery('deliv_01KDELIVERYTEST0000000000');

  expect(item?.deliveryId).toBe('deliv_01KDELIVERYTEST0000000000');
  expect(delivery).toMatchObject({
    id: 'deliv_01KDELIVERYTEST0000000000',
    sessionId: 'ses_01KPROJECTDELIVERY000000000',
    memberInstanceId: 'pmem_codex_1',
    externalAgentSessionId: 'exa_1',
    triggerMessageId: 'msg_01KDELIVERYTRIGGER00000000',
    triggerMessageSeq: 1,
    state: 'queued',
    turn: { providerSessionRef: 'provider-session-1', providerTurnId: 'turn-1' }
  });
});

test('deleteSession cleans up external agent session rows', () => {
  store.upsertExternalAgentSession(row);
  store.insertMessage('msg_cleanup', 'ses_project', 'cleanup', '2026-06-28T00:00:01.000Z', 'user');
  expect(store.enqueueExternalAgentInboxItem('exa_1', 1)).toBe(true);
  store.insertNativeAgentDirectMessage({
    id: 'msg_direct_cleanup',
    sessionId: 'ses_project',
    externalAgentSessionId: 'exa_1',
    fromAgent: 'codex',
    peer: 'claude',
    text: 'private',
    createdAt: '2026-06-28T00:00:02.000Z'
  });
  expect(store.listNativeAgentDirectMessages('exa_1', 'claude')).toHaveLength(1);

  store.deleteWorkplaceProject('ses_project');

  store.upsertExternalAgentSession(row);
  expect(store.enqueueExternalAgentInboxItem('exa_1', 1)).toBe(true);
});
