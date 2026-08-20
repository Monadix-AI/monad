import type { Session, SessionId, WorkplaceProject } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '@monad/protocol';
import { sql } from 'drizzle-orm';

import { createStore } from '#/store/db/index.ts';
import { sessions, workplaceProjects } from '#/store/db/schema.ts';

function fixtureSession(over: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  return {
    id: newId('ses'),
    title: 'test',
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
    createdAt: now,
    updatedAt: now,
    ...over
  };
}

function fixtureProject(over: Partial<WorkplaceProject> = {}): WorkplaceProject {
  const now = new Date().toISOString();
  return {
    id: newId('prj'),
    title: 'project',
    state: 'active',
    archived: false,
    memberTemplates: [],
    createdAt: now,
    updatedAt: now,
    ...over
  };
}

function countRows(store: ReturnType<typeof createStore>, table: string, column: string, value: string): number {
  return store.db.all(sql`SELECT 1 FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} = ${value}`).length;
}

function fixtureDbId(prefix: 'evt' | 'msg', suffix: string): string {
  return `${prefix}_${suffix.replaceAll('_', '').padEnd(12, '0').slice(0, 12)}`;
}

function seedTranscriptRows(
  store: ReturnType<typeof createStore>,
  transcriptTargetId: string,
  suffix: string,
  now: string
): { messageId: string; requestId: string } {
  const messageId = fixtureDbId('msg', suffix);
  const requestId = `req_${suffix}`;
  store.db.run(sql`INSERT INTO messages
    (id, transcript_target_id, role, text, type, stream_status, active, created_at)
    VALUES (${messageId}, ${transcriptTargetId}, 'user', ${suffix}, 'text', 'settled', 1, ${now})`);
  store.db.run(sql`INSERT INTO message_embeddings (message_id, dim, vec, model)
    VALUES (${messageId}, 1, ${new Uint8Array([1])}, 'test')`);
  store.db.run(sql`INSERT INTO transcript_message_revisions (transcript_target_id, revision)
    VALUES (${transcriptTargetId}, 2)`);
  store.db.run(sql`INSERT INTO message_mutations
    (transcript_target_id, idempotency_key, command_fingerprint, message_id, message_revision, result_message)
    VALUES (${transcriptTargetId}, ${`key_${suffix}`}, ${`fingerprint_${suffix}`}, ${messageId}, 2, '{}')`);
  store.db.run(sql`INSERT INTO events (id, transcript_target_id, type, payload, at)
    VALUES (${fixtureDbId('evt', suffix)}, ${transcriptTargetId}, 'clarify.requested', ${JSON.stringify({ requestId })}, ${now})`);
  store.db.run(sql`INSERT INTO tool_raw_outputs (transcript_target_id, tool_call_id, output, created_at)
    VALUES (${transcriptTargetId}, ${`call_${suffix}`}, 'raw', ${now})`);
  store.db.run(sql`INSERT INTO memory (session_id, key, value)
    VALUES (${transcriptTargetId}, ${`memory_${suffix}`}, '{}')`);
  store.db.run(sql`INSERT INTO file_observations
    (session_id, path, hash, coverage, observed_at)
    VALUES (${transcriptTargetId}, ${`/${suffix}.txt`}, 'hash', 'full', ${now})`);
  store.markOperatorInboxRead([`mention:${messageId}`, `approval:${requestId}`, `hitl:${requestId}`], now);
  return { messageId, requestId };
}

function seedSessionRows(store: ReturnType<typeof createStore>, sessionId: string, suffix: string, now: string): void {
  const meshSessionId = `mesh_${suffix}`;
  store.db.run(sql`INSERT INTO session_members
    (session_id, member_id, template_id, type, data, created_at, updated_at)
    VALUES (${sessionId}, ${`member_${suffix}`}, ${`member_${suffix}`}, 'mesh-agent', '{}', ${now}, ${now})`);
  store.db.run(sql`INSERT INTO acp_delegates
    (id, session_id, agent_name, acp_session_id, pid, spawned_at, last_used_at, reuse_count, prompt_count)
    VALUES (${`delegate_${suffix}`}, ${sessionId}, 'codex', ${`acp_${suffix}`}, 1, ${now}, ${now}, 0, 0)`);
  store.db.run(sql`INSERT INTO channel_conversations
    (channel_id, conversation_key, active_session_id, created_at, last_seen_at)
    VALUES ('test', ${`conversation_${suffix}`}, ${sessionId}, ${now}, ${now})`);
  store.db.run(sql`INSERT INTO channel_conversation_sessions
    (channel_id, conversation_key, session_id, label, created_at)
    VALUES ('test', ${`conversation_${suffix}`}, ${sessionId}, 'label', ${now})`);
  store.db.run(sql`INSERT INTO mesh_sessions
    (id, transcript_target_id, agent_name, provider, working_path, runtime_role, last_delivered_seq,
     last_visible_seq, state, started_at, updated_at)
    VALUES (${meshSessionId}, ${sessionId}, 'codex', 'codex', '/tmp', 'interactive', 0, 0, 'running', ${now}, ${now})`);
  store.db.run(sql`INSERT INTO mesh_agent_inbox_items
    (mesh_session_id, message_seq, project_id, member_instance_id, state, created_at, updated_at)
    VALUES (${meshSessionId}, 1, NULL, ${`member_${suffix}`}, 'queued', ${now}, ${now})`);
  store.db.run(sql`INSERT INTO native_agent_direct_messages
    (id, session_id, mesh_session_id, peer, text, created_at)
    VALUES (${`dm_${suffix}`}, ${sessionId}, ${meshSessionId}, 'peer', 'private', ${now})`);
  store.db.run(sql`INSERT INTO message_attachments
    (id, session_id, path, name, mime, bytes, preview, created_at)
    VALUES (${`attachment_${suffix}`}, ${sessionId}, '/tmp/file', 'file', 'text/plain', 1, 'x', ${now})`);
}

function seedProjectRows(
  store: ReturnType<typeof createStore>,
  projectId: string,
  projectSessionId: string,
  suffix: string,
  now: string
): void {
  const requestId = `ask_${suffix}`;
  store.compareAndSwapExperienceState({
    atomPackId: `atom_${suffix}`,
    projectId,
    key: 'state',
    expectedVersion: null,
    value: { suffix },
    event: { kind: 'set' }
  });
  store.db.run(sql`INSERT INTO experience_worker_wakeups
    (atom_pack_id, experience_id, project_id, wake_key, run_at, attempt, updated_at)
    VALUES (${`atom_${suffix}`}, 'experience', ${projectId}, 'wake', ${now}, 0, ${now})`);
  store.db.run(sql`INSERT INTO mesh_agent_ingress_counters
    (project_id, member_instance_id, next_seq, updated_at)
    VALUES (${projectId}, ${`member_${suffix}`}, 2, ${now})`);
  store.db.run(sql`INSERT INTO native_agent_ingress_items
    (id, project_id, member_instance_id, ingress_seq, source_kind, state, created_at, updated_at)
    VALUES (${`ingress_${suffix}`}, ${projectId}, ${`member_${suffix}`}, 1, 'message', 'queued', ${now}, ${now})`);
  store.db.run(sql`INSERT INTO native_agent_asks
    (request_id, project_id, project_session_id, member_instance_id, blocking, state, created_at, updated_at)
    VALUES (${requestId}, ${projectId}, ${projectSessionId}, ${`member_${suffix}`}, 1, 'pending', ${now}, ${now})`);
  store.db.run(sql`INSERT INTO native_agent_ask_questions
    (request_id, question_id, position, question, options, mode, allow_other)
    VALUES (${requestId}, ${`question_${suffix}`}, 0, 'Continue?', '[]', 'single', 1)`);
  store.db.run(sql`INSERT INTO native_agent_member_gates
    (project_id, project_session_id, member_instance_id, request_id, state, created_at, updated_at)
    VALUES (${projectId}, ${projectSessionId}, ${`member_${suffix}`}, ${requestId}, 'waiting', ${now}, ${now})`);
  store.db.run(sql`INSERT INTO native_agent_recovery_batches
    (id, project_id, member_instance_id, ask_request_id, high_water_seq, state, created_at, updated_at)
    VALUES (${`batch_${suffix}`}, ${projectId}, ${`member_${suffix}`}, ${requestId}, 1, 'pending', ${now}, ${now})`);
  store.db.run(sql`INSERT INTO mesh_agent_inbox_items
    (mesh_session_id, message_seq, project_id, member_instance_id, state, created_at, updated_at)
    VALUES (${`project_mesh_${suffix}`}, 1, ${projectId}, ${`member_${suffix}`}, 'queued', ${now}, ${now})`);
  store.markOperatorInboxRead([`hitl:${requestId}`], now);
}

test('updateSession merges fields and bumps updatedAt', async () => {
  const store = createStore();
  const s = fixtureSession({ title: 'old', updatedAt: '2000-01-01T00:00:00.000Z' });
  store.insertSession(s);

  const updated = store.updateSession(s.id, { title: 'new', state: 'paused', archived: true });
  expect(updated?.title).toBe('new');
  expect(updated?.state).toBe('paused');
  expect(updated?.archived).toBe(true);
  expect(updated?.updatedAt).not.toBe('2000-01-01T00:00:00.000Z');
  store.close();
});

test('session model and effort persist through the shared model column', () => {
  const store = createStore();
  const session = fixtureSession({ model: 'openrouter:gpt-5', reasoningEffort: 'high' });
  store.insertSession(session);

  expect(store.db.select({ model: sessions.model }).from(sessions).get()?.model).toBe(
    '{"model":"openrouter:gpt-5","effort":"high"}'
  );
  expect(store.getSession(session.id)).toMatchObject({ model: 'openrouter:gpt-5', reasoningEffort: 'high' });

  store.updateSession(session.id, { reasoningEffort: null });
  expect(store.db.select({ model: sessions.model }).from(sessions).get()?.model).toBe('{"model":"openrouter:gpt-5"}');
  expect(store.getSession(session.id)).toMatchObject({ model: 'openrouter:gpt-5' });
  expect(store.getSession(session.id)?.reasoningEffort).toBeUndefined();
  store.close();
});

test('listSessions filters by archived and state', () => {
  const store = createStore();
  store.insertSession(fixtureSession({ state: 'active', archived: false }));
  store.insertSession(fixtureSession({ state: 'completed', archived: false }));
  store.insertSession(fixtureSession({ state: 'active', archived: true }));

  expect(store.listSessions().length).toBe(3);
  expect(store.listSessions({ archived: false }).length).toBe(2);
  expect(store.listSessions({ archived: true }).length).toBe(1);
  expect(store.listSessions({ state: 'active' }).length).toBe(2);
  expect(store.listSessions({ state: 'active', archived: false }).length).toBe(1);
  store.close();
});

test('listSessions classifies one Agent before pagination', () => {
  const store = createStore();
  const agentA = newId('agt');
  const agentB = newId('agt');
  const project = fixtureProject();
  store.insertWorkplaceProject(project);
  const chatOlder = fixtureSession({
    agentIds: [agentA],
    updatedAt: '2026-01-01T00:00:00.000Z',
    origin: {
      surface: 'web',
      client: 'monad-web',
      transport: 'http'
    }
  });
  const chatNewer = fixtureSession({
    agentIds: [agentA],
    updatedAt: '2026-01-02T00:00:00.000Z',
    origin: {
      surface: 'web',
      client: 'monad-web',
      transport: 'http'
    }
  });
  const projectSession = fixtureSession({ agentIds: [agentA], projectId: project.id });
  const monadixSession = fixtureSession({
    agentIds: [agentA],
    origin: {
      surface: 'web',
      client: 'monadix',
      transport: 'http'
    }
  });
  const otherAgent = fixtureSession({ agentIds: [agentB] });
  for (const session of [chatOlder, chatNewer, projectSession, monadixSession, otherAgent]) {
    store.insertSession(session);
  }

  expect({
    chat: store.listSessions({ agentId: agentA, kind: 'chat' }).map((session) => session.id),
    project: store.listSessions({ agentId: agentA, kind: 'project' }).map((session) => session.id),
    monadix: store.listSessions({ agentId: agentA, kind: 'monadix' }).map((session) => session.id),
    secondChat: store.listSessions({ agentId: agentA, kind: 'chat', limit: 1, offset: 1 }).map((session) => session.id),
    chatTotal: store.countSessions({ agentId: agentA, kind: 'chat' })
  }).toEqual({
    chat: [chatNewer.id, chatOlder.id],
    project: [projectSession.id],
    monadix: [monadixSession.id],
    secondChat: [chatOlder.id],
    chatTotal: 2
  });
  store.close();
});

test('listSessions searches title, id, and project title within the archived scope', () => {
  const store = createStore();
  const project = fixtureProject({ title: 'Runtime Console' });
  const titleMatch = fixtureSession({ title: 'Investigate Gateway', archived: false });
  const projectMatch = fixtureSession({ title: 'Agent notes', projectId: project.id, archived: false });
  const archivedMatch = fixtureSession({ title: 'Gateway archive', archived: true });
  store.insertWorkplaceProject(project);
  store.insertSession(titleMatch);
  store.insertSession(projectMatch);
  store.insertSession(archivedMatch);

  expect(store.listSessions({ archived: false, query: 'gateway' }).map((session) => session.id)).toEqual([
    titleMatch.id
  ]);
  expect(store.listSessions({ archived: false, query: titleMatch.id.slice(-8) }).map((session) => session.id)).toEqual([
    titleMatch.id
  ]);
  expect(store.listSessions({ archived: false, query: 'runtime console' }).map((session) => session.id)).toEqual([
    projectMatch.id
  ]);
  expect(store.listSessions({ archived: true, query: 'gateway' }).map((session) => session.id)).toEqual([
    archivedMatch.id
  ]);
  expect(store.countSessions({ archived: false, query: 'gateway' })).toBe(1);
  store.close();
});

test('workplace projects use explicit project storage instead of agent sessions', () => {
  const store = createStore();
  const project = fixtureProject({
    title: 'project',
    origin: {
      surface: 'web',
      client: 'workplace',
      transport: 'http'
    },
    cwd: '/tmp/workplace-project'
  });
  const agentSession = fixtureSession({ title: 'agent', agentIds: [newId('agt')] });

  store.insertWorkplaceProject(project);
  store.insertSession(agentSession);
  store.setMemory(agentSession.id, 'ctx:summary', JSON.stringify({ summary: 'session memory' }));

  expect(store.db.select().from(sessions).all()).toHaveLength(1);
  expect(store.db.select().from(workplaceProjects).all()).toHaveLength(1);
  expect(store.getWorkplaceProject(project.id)?.title).toBe('project');
  expect(store.listSessions().map((session) => session.id)).not.toContain(project.id);
  expect(store.listWorkplaceProjects().map((candidate) => candidate.id)).toContain(project.id);

  const updated = store.updateWorkplaceProject(project.id, { title: 'renamed', archived: true });
  expect(updated?.title).toBe('renamed');
  expect(updated?.archived).toBe(true);
  expect(store.countSessions({ archived: true })).toBe(0);
  expect(store.countWorkplaceProjects({ archived: true })).toBe(1);

  expect(store.deleteWorkplaceProject(project.id)).toBe(true);
  store.close();
});

test('deleteWorkplaceProject deletes every Monad-owned row and preserves unrelated data and local files', () => {
  const store = createStore();
  const cwd = mkdtempSync(join(tmpdir(), 'monad-project-delete-'));
  const keepPath = join(cwd, 'keep.txt');
  writeFileSync(keepPath, 'keep local file');
  const project = fixtureProject({ cwd });
  const unrelatedProject = fixtureProject();
  const owned = fixtureSession({ projectId: project.id });
  const unrelated = fixtureSession({ projectId: unrelatedProject.id });
  const now = new Date().toISOString();

  try {
    store.insertWorkplaceProject(project);
    store.insertWorkplaceProject(unrelatedProject);
    store.insertSession(owned);
    store.insertSession(unrelated);
    seedTranscriptRows(store, owned.id, 'owned_session', now);
    seedTranscriptRows(store, project.id, 'owned_project', now);
    seedTranscriptRows(store, unrelated.id, 'unrelated_session', now);
    seedTranscriptRows(store, unrelatedProject.id, 'unrelated_project', now);
    seedSessionRows(store, owned.id, 'owned_session', now);
    seedSessionRows(store, project.id, 'owned_project', now);
    seedSessionRows(store, unrelated.id, 'unrelated_session', now);
    seedSessionRows(store, unrelatedProject.id, 'unrelated_project', now);
    seedProjectRows(store, project.id, owned.id, 'owned', now);
    seedProjectRows(store, unrelatedProject.id, unrelated.id, 'unrelated', now);

    expect(store.deleteWorkplaceProject(project.id)).toBe(true);

    expect({
      project: store.getWorkplaceProject(project.id),
      ownedSession: store.getSession(owned.id),
      members: countRows(store, 'session_members', 'session_id', owned.id),
      memory: countRows(store, 'memory', 'session_id', owned.id) + countRows(store, 'memory', 'session_id', project.id),
      observations:
        countRows(store, 'file_observations', 'session_id', owned.id) +
        countRows(store, 'file_observations', 'session_id', project.id),
      messages:
        countRows(store, 'messages', 'transcript_target_id', owned.id) +
        countRows(store, 'messages', 'transcript_target_id', project.id),
      embeddings: countRows(store, 'message_embeddings', 'message_id', fixtureDbId('msg', 'owned_session')),
      revisions:
        countRows(store, 'transcript_message_revisions', 'transcript_target_id', owned.id) +
        countRows(store, 'transcript_message_revisions', 'transcript_target_id', project.id),
      mutations:
        countRows(store, 'message_mutations', 'transcript_target_id', owned.id) +
        countRows(store, 'message_mutations', 'transcript_target_id', project.id),
      events:
        countRows(store, 'events', 'transcript_target_id', owned.id) +
        countRows(store, 'events', 'transcript_target_id', project.id),
      rawOutputs:
        countRows(store, 'tool_raw_outputs', 'transcript_target_id', owned.id) +
        countRows(store, 'tool_raw_outputs', 'transcript_target_id', project.id),
      delegates: countRows(store, 'acp_delegates', 'session_id', owned.id),
      channelHistory: countRows(store, 'channel_conversation_sessions', 'session_id', owned.id),
      activeChannels: countRows(store, 'channel_conversations', 'active_session_id', owned.id),
      directMessages: countRows(store, 'native_agent_direct_messages', 'session_id', owned.id),
      attachments: countRows(store, 'message_attachments', 'session_id', owned.id),
      meshSessions:
        countRows(store, 'mesh_sessions', 'transcript_target_id', owned.id) +
        countRows(store, 'mesh_sessions', 'transcript_target_id', project.id),
      meshInbox: countRows(store, 'mesh_agent_inbox_items', 'project_id', project.id),
      experienceState: countRows(store, 'experience_state', 'project_id', project.id),
      experienceEvents: countRows(store, 'experience_state_events', 'project_id', project.id),
      wakeups: countRows(store, 'experience_worker_wakeups', 'project_id', project.id),
      ingressCounters: countRows(store, 'mesh_agent_ingress_counters', 'project_id', project.id),
      ingressItems: countRows(store, 'native_agent_ingress_items', 'project_id', project.id),
      asks: countRows(store, 'native_agent_asks', 'project_id', project.id),
      askQuestions: countRows(store, 'native_agent_ask_questions', 'request_id', 'ask_owned'),
      memberGates: countRows(store, 'native_agent_member_gates', 'project_id', project.id),
      recovery: countRows(store, 'native_agent_recovery_batches', 'project_id', project.id),
      inboxReads:
        countRows(store, 'inbox_item_reads', 'item_key', `mention:${fixtureDbId('msg', 'owned_session')}`) +
        countRows(store, 'inbox_item_reads', 'item_key', 'approval:req_owned_session') +
        countRows(store, 'inbox_item_reads', 'item_key', 'hitl:req_owned_session') +
        countRows(store, 'inbox_item_reads', 'item_key', 'hitl:ask_owned'),
      localFile: readFileSync(keepPath, 'utf8')
    }).toEqual({
      project: null,
      ownedSession: null,
      members: 0,
      memory: 0,
      observations: 0,
      messages: 0,
      embeddings: 0,
      revisions: 0,
      mutations: 0,
      events: 0,
      rawOutputs: 0,
      delegates: 0,
      channelHistory: 0,
      activeChannels: 0,
      directMessages: 0,
      attachments: 0,
      meshSessions: 0,
      meshInbox: 0,
      experienceState: 0,
      experienceEvents: 0,
      wakeups: 0,
      ingressCounters: 0,
      ingressItems: 0,
      asks: 0,
      askQuestions: 0,
      memberGates: 0,
      recovery: 0,
      inboxReads: 0,
      localFile: 'keep local file'
    });

    expect({
      project: store.getWorkplaceProject(unrelatedProject.id)?.id,
      session: store.getSession(unrelated.id)?.id,
      messages: countRows(store, 'messages', 'transcript_target_id', unrelated.id),
      members: countRows(store, 'session_members', 'session_id', unrelated.id),
      meshInbox: countRows(store, 'mesh_agent_inbox_items', 'project_id', unrelatedProject.id),
      experienceState: countRows(store, 'experience_state', 'project_id', unrelatedProject.id),
      ingress: countRows(store, 'native_agent_ingress_items', 'project_id', unrelatedProject.id),
      asks: countRows(store, 'native_agent_asks', 'project_id', unrelatedProject.id),
      askQuestions: countRows(store, 'native_agent_ask_questions', 'request_id', 'ask_unrelated'),
      readMarker: countRows(store, 'inbox_item_reads', 'item_key', 'hitl:ask_unrelated')
    }).toEqual({
      project: unrelatedProject.id,
      session: unrelated.id,
      messages: 1,
      members: 1,
      meshInbox: 1,
      experienceState: 1,
      ingress: 1,
      asks: 1,
      askQuestions: 1,
      readMarker: 1
    });
  } finally {
    store.close();
    rmSync(cwd, { force: true, recursive: true });
  }
});

test('deleteWorkplaceProject rolls back every owned row when deleting the project record fails', () => {
  const store = createStore();
  const project = fixtureProject();
  const owned = fixtureSession({ projectId: project.id });
  const now = new Date().toISOString();
  store.insertWorkplaceProject(project);
  store.insertSession(owned);
  seedTranscriptRows(store, owned.id, 'rollback', now);
  store.db.run(
    sql.raw(`CREATE TRIGGER block_project_delete BEFORE DELETE ON workplace_projects
    BEGIN SELECT RAISE(ABORT, 'forced project delete failure'); END`)
  );

  expect(() => store.deleteWorkplaceProject(project.id)).toThrow('forced project delete failure');
  expect({
    project: store.getWorkplaceProject(project.id)?.id,
    session: store.getSession(owned.id)?.id,
    messages: store.listMessages(owned.id).map((message) => message.text)
  }).toEqual({ project: project.id, session: owned.id, messages: ['rollback'] });
  store.close();
});

test('deleteSession cascades session-owned project data', () => {
  const store = createStore();
  const s = fixtureSession();
  store.insertSession(s);
  store.insertMessage(newId('msg'), s.id, 'hi', new Date().toISOString(), 'user');
  store.setMemory(s.id, 'ctx:summary', JSON.stringify({ summary: 'delete me' }));
  store.setActiveSession({
    channelId: 'discord',
    conversationKey: 'thread-1',
    sessionId: s.id,
    label: 'project'
  });
  store.appendEvents([
    {
      id: newId('evt'),
      sessionId: s.id,
      type: 'session.created',
      actorAgentId: null,
      payload: { title: s.title },
      at: new Date().toISOString()
    }
  ]);

  expect(store.deleteSession(s.id)).toBe(true);
  expect(store.deleteSession(s.id)).toBe(false); // already gone
  store.close();
});

test('clearMessages removes messages + events but keeps the session', () => {
  const store = createStore();
  const s = fixtureSession();
  store.insertSession(s);
  store.insertMessage(newId('msg'), s.id, 'hi', new Date().toISOString(), 'user');
  store.insertMessage(newId('msg'), s.id, 'hello', new Date().toISOString(), 'assistant');
  store.appendEvents([
    {
      id: newId('evt'),
      sessionId: s.id,
      type: 'session.created',
      actorAgentId: null,
      payload: { title: s.title },
      at: new Date().toISOString()
    }
  ]);

  const cleared = store.clearMessages(s.id);
  expect(cleared).toBe(2); // 2 messages deleted
  store.close();
});

test('clearMessages removes Workplace Project transcript data and keeps the project', () => {
  const store = createStore();
  const project = fixtureProject({ title: 'project', updatedAt: '2000-01-01T00:00:00.000Z' });
  store.insertWorkplaceProject(project);
  store.insertMessage(newId('msg'), project.id, 'hi', new Date().toISOString(), 'user');
  store.appendEvents([
    {
      id: newId('evt'),
      sessionId: project.id as unknown as SessionId,
      type: 'session.created',
      actorAgentId: null,
      payload: { title: project.title },
      at: new Date().toISOString()
    }
  ]);
  store.setMemory(project.id, 'ctx:summary', JSON.stringify({ summary: 'delete me' }));

  const cleared = store.clearMessages(project.id);
  expect(cleared).toBe(1);
  expect(store.getWorkplaceProject(project.id)?.updatedAt).not.toBe('2000-01-01T00:00:00.000Z');
  store.close();
});

test('file observations upsert and follow session cleanup', () => {
  const store = createStore();
  const first = fixtureSession();
  const second = fixtureSession();
  const now = new Date().toISOString();
  store.insertSession(first);
  store.insertSession(second);
  store.insertMessage(newId('msg'), first.id, 'first', now, 'user');
  store.insertMessage(newId('msg'), second.id, 'second', now, 'user');
  store.recordFileObservation(first.id, {
    path: '/tmp/a.txt',
    hash: 'hash-a1',
    coverage: 'full',
    observedAt: now,
    toolCallId: 'call_1'
  });
  store.recordFileObservation(first.id, {
    path: '/tmp/a.txt',
    hash: 'hash-a2',
    coverage: 'full',
    observedAt: now,
    toolCallId: 'call_2'
  });
  store.recordFileObservation(second.id, {
    path: '/tmp/a.txt',
    hash: 'hash-b',
    coverage: 'full',
    observedAt: now
  });

  expect(store.getFileObservation(first.id, '/tmp/a.txt')).toMatchObject({ hash: 'hash-a2', toolCallId: 'call_2' });
  expect(store.clearMessages(first.id)).toBe(1);
  expect(store.getSession(first.id)?.id).toBe(first.id);
  expect(store.getFileObservation(first.id, '/tmp/a.txt')).toBeNull();
  expect(store.getFileObservation(second.id, '/tmp/a.txt')?.hash).toBe('hash-b');
  expect(store.deleteSession(second.id)).toBe(true);
  expect(store.getFileObservation(second.id, '/tmp/a.txt')).toBeNull();
  store.close();
});

test('restore clears file observations when the rewound range contains a newer observation', () => {
  const store = createStore();
  const s = fixtureSession();
  const before = '2026-01-01T00:00:00.000Z';
  const targetAt = '2026-01-01T00:01:00.000Z';
  const after = '2026-01-01T00:02:00.000Z';
  store.insertSession(s);
  const first = newId('msg');
  const second = newId('msg');
  store.insertMessage(first, s.id, 'first', before, 'assistant');
  store.insertMessage(second, s.id, 'second', targetAt, 'user');
  store.recordFileObservation(s.id, {
    path: '/tmp/older.txt',
    hash: 'hash-older',
    coverage: 'full',
    observedAt: before,
    toolCallId: 'call_older'
  });
  store.recordFileObservation(s.id, {
    path: '/tmp/newer.txt',
    hash: 'hash-newer',
    coverage: 'full',
    observedAt: after,
    toolCallId: 'call_newer'
  });

  store.restoreMessages(s.id, second);
  expect(store.listMessages(s.id)).toHaveLength(1);
  expect(store.getFileObservation(s.id, '/tmp/older.txt')).toBeNull();
  expect(store.getFileObservation(s.id, '/tmp/newer.txt')).toBeNull();
  store.close();
});

test('restore preserves file observations when no observation falls inside the rewound range', () => {
  const store = createStore();
  const s = fixtureSession();
  const before = '2026-01-01T00:00:00.000Z';
  const targetAt = '2026-01-01T00:01:00.000Z';
  store.insertSession(s);
  const first = newId('msg');
  const second = newId('msg');
  store.insertMessage(first, s.id, 'first', before, 'assistant');
  store.insertMessage(second, s.id, 'second', targetAt, 'user');
  store.recordFileObservation(s.id, {
    path: '/tmp/older.txt',
    hash: 'hash-older',
    coverage: 'full',
    observedAt: before,
    toolCallId: 'call_older'
  });

  store.restoreMessages(s.id, second);
  expect(store.listMessages(s.id).map((m) => m.id)).toEqual([first]);
  expect(store.getFileObservation(s.id, '/tmp/older.txt')).toMatchObject({ hash: 'hash-older' });
  store.close();
});

test('messages carry the three-layer shape (text/type/data/stream/active)', () => {
  const store = createStore();
  const s = fixtureSession();
  store.insertSession(s);
  const id = newId('msg');
  store.insertMessage(id, s.id, 'Card: 3 results', new Date().toISOString(), 'assistant', {
    type: 'card',
    data: { items: [1, 2, 3] },
    streamStatus: 'complete'
  });

  const [m] = store.listMessages(s.id);
  expect(m?.text).toBe('Card: 3 results');
  expect(m?.type).toBe('card');
  expect(m?.data).toEqual({ items: [1, 2, 3] });
  expect(m?.stream.status).toBe('complete');
  expect(m?.active).toBe(true);
  store.close();
});

test('updateSession patches cwd and origin', () => {
  const store = createStore();
  const s = fixtureSession();
  store.insertSession(s);

  const validOrigin = {
    surface: 'api' as const,
    client: 'test',
    transport: 'http' as const
  };
  const updated = store.updateSession(s.id, { cwd: '/home/user/project', origin: validOrigin });
  expect(updated?.cwd).toBe('/home/user/project');
  expect(updated?.origin).toMatchObject({ surface: 'api', transport: 'http' });

  // Clearing fields back to null works too.
  const cleared = store.updateSession(s.id, { cwd: null, origin: null });
  expect(cleared?.cwd).toBeUndefined();
  expect(cleared?.origin).toBeUndefined();
  store.close();
});

test('listMessages: active-only default, includeInactive, limit, before', () => {
  const store = createStore();
  const s = fixtureSession();
  store.insertSession(s);
  const ids = ['a', 'b', 'c'].map((t) => {
    const id = newId('msg');
    store.insertMessage(id, s.id, t, new Date().toISOString(), 'user');
    return id;
  });

  // soft-delete the last message (simulate restore/rewind)
  store.db.run(sql`UPDATE messages SET active = 0 WHERE id = ${ids[2]}`);

  expect(store.listMessages(s.id).map((m) => m.text)).toEqual(['a', 'b']);
  expect(store.listMessages(s.id, { includeInactive: true }).map((m) => m.text)).toEqual(['a', 'b', 'c']);
  expect(store.listMessages(s.id, { limit: 1 }).map((m) => m.text)).toEqual(['a']);
  expect(store.listMessages(s.id, { before: ids[1] as string }).map((m) => m.text)).toEqual(['a']);
  store.close();
});
