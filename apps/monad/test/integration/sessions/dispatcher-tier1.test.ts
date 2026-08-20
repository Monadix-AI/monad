import type { Hooks, SessionId } from '@monad/protocol';
import type { MeshAgentProviderSessionLifecycleContext } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { HandlerError } from '#/handlers/handler-error.ts';
import { getMeshAgentProviderAdapter } from '#/services/mesh-agent/index.ts';
import { createStore } from '#/store/db/index.ts';
import { buildHandlers, mockModel } from '../../helpers.ts';
import { waitFor } from '../../wait.ts';

test('sessionGet reports a well-formed id for a missing session as not_found', async () => {
  const d = buildHandlers(mockModel(['hi']));
  // `invalid` would surface as HTTP 400 with the message scrubbed to "request validation failed",
  // leaving a caller unable to tell a malformed id from a session that simply is not there.
  await expect(d.session.get({ id: 'ses_nope00000000' as SessionId })).rejects.toMatchObject({
    kind: 'not_found',
    message: 'session not found: ses_nope00000000'
  });
  await expect(d.session.get({ id: 'ses_nope00000000' as SessionId })).rejects.toBeInstanceOf(HandlerError);
});

test('sessionUpdate rejects an illegal state transition', async () => {
  const d = buildHandlers(mockModel(['hi']));
  const { sessionId } = await d.session.create({ title: 't' });
  await d.session.update({ id: sessionId, state: 'completed' }); // active -> completed (ok, terminal)
  await expect(d.session.update({ id: sessionId, state: 'active' })).rejects.toMatchObject({
    kind: 'invalid'
  });
});

test('sessionUpdate renames + archives and returns the new session', async () => {
  const d = buildHandlers(mockModel(['hi']));
  const { sessionId } = await d.session.create({ title: 'old' });
  const { session } = await d.session.update({ id: sessionId, title: 'new', archived: true });
  expect(session.title).toBe('new');
  expect(session.archived).toBe(true);
});

test('sessionDelete queues deletion and hides the session from handler reads', async () => {
  const store = createStore();
  const d = buildHandlers(mockModel(['hi']), undefined, { store });
  const { sessionId } = await d.session.create({ title: 't' });
  const { sessionId: otherSessionId } = await d.session.create({ title: 'other' });
  expect(await d.session.delete({ id: sessionId })).toEqual({ deleted: true });
  await expect(d.session.get({ id: sessionId })).rejects.toBeInstanceOf(HandlerError);
  expect((await d.session.list({})).sessions.map((session) => session.id)).toEqual([otherSessionId]);
  expect((await d.session.list({})).total).toBe(1);
  expect(store.getSession(sessionId)?.id).toBe(sessionId);
  expect(await d.session.undoDelete({ id: sessionId })).toEqual({ undone: true });
  expect((await d.session.get({ id: sessionId })).session.title).toBe('t');
  store.close();
});

test('session list applies server-side search before pagination', async () => {
  const d = buildHandlers(mockModel(['hi']));
  const { sessionId: alphaId } = await d.session.create({ title: 'Alpha runtime' });
  await d.session.create({ title: 'Beta notes' });

  expect(await d.session.list({ archived: false, query: 'alpha', limit: 1, offset: 0 })).toMatchObject({
    sessions: [{ id: alphaId, title: 'Alpha runtime' }],
    total: 1
  });
});

test('sessionDelete undo preserves session_members rows', async () => {
  const store = createStore();
  const d = buildHandlers(mockModel(['hi']), undefined, { store });
  const { sessionId } = await d.session.create({ title: 't' });
  store.insertSessionMember({
    sessionId,
    memberId: 'pmem_codex_a',
    templateId: 'pmem_codex_a',
    type: 'mesh-agent',
    data: { name: 'codex', instanceId: 'pmem_codex_a' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  expect(store.listSessionMembers(sessionId)).toHaveLength(1);
  await d.session.delete({ id: sessionId });
  await d.session.undoDelete({ id: sessionId });
  expect(store.listSessionMembers(sessionId)).toHaveLength(1);
  store.close();
});

test('sessionDelete hides queued project sessions from project lists', async () => {
  const store = createStore();
  const d = buildHandlers(mockModel(['hi']), undefined, { store });
  const { projectId } = await d.session.createProject({ title: 'p' });
  const { sessionId } = await d.session.createProjectSession({ projectId, title: 'project session' });
  expect(await d.session.listProjectSessions({ projectId })).toMatchObject({
    total: 1
  });

  await d.session.delete({ id: sessionId });
  expect(await d.session.listProjectSessions({ projectId })).toMatchObject({
    sessions: [],
    total: 0
  });

  await d.session.undoDelete({ id: sessionId });
  expect((await d.session.listProjectSessions({ projectId })).sessions.map((session) => session.id)).toEqual([
    sessionId
  ]);
  store.close();
});

test('sessionDelete keeps the session hidden while native cleanup is in progress', async () => {
  const store = createStore();
  const d = buildHandlers(mockModel(['hi']), undefined, { store, sessionDeleteGraceMs: 1 });
  const adapter = getMeshAgentProviderAdapter('codex');
  const originalDeleteSession = adapter.deleteSession;
  const cleanupStarted = Promise.withResolvers<void>();
  const releaseCleanup = Promise.withResolvers<void>();
  adapter.deleteSession = async () => {
    cleanupStarted.resolve();
    await releaseCleanup.promise;
  };

  try {
    const { sessionId } = await d.session.create({ title: 'deleting native session' });
    const now = '2026-08-19T00:00:00.000Z';
    store.upsertMeshSession({
      id: 'mesh_deletinghidden',
      transcriptTargetId: sessionId,
      agentName: 'pmem_codex_deleting',
      provider: 'codex',
      workingPath: '/tmp/deleting-native-session',
      runtimeRole: 'interactive',
      agentRuntimeId: null,
      agentRuntimeTokenHash: null,
      lastDeliveredSeq: 0,
      lastVisibleSeq: 0,
      state: 'stopped',
      pid: null,
      providerSessionRef: 'thread_deleting_hidden',
      outputSnapshot: '',
      exitCode: 0,
      startedAt: now,
      updatedAt: now,
      exitedAt: now
    });

    await d.session.delete({ id: sessionId });
    await cleanupStarted.promise;

    expect(await d.session.list({})).toMatchObject({ sessions: [], total: 0 });
    await expect(d.session.get({ id: sessionId })).rejects.toBeInstanceOf(HandlerError);
    expect(await d.session.undoDelete({ id: sessionId })).toEqual({ undone: false });

    releaseCleanup.resolve();
    await waitFor(() => store.getSession(sessionId) === null, {
      message: 'native session storage was not deleted after cleanup completed'
    });
    expect(store.getSession(sessionId)).toBeNull();
  } finally {
    releaseCleanup.resolve();
    adapter.deleteSession = originalDeleteSession;
    store.close();
  }
});

test('project session archive, unarchive, and delete apply provider lifecycle hooks on transitions', async () => {
  const store = createStore();
  const d = buildHandlers(mockModel(['hi']), undefined, { store, sessionDeleteGraceMs: 1 });
  const adapter = getMeshAgentProviderAdapter('codex');
  const originalArchiveSession = adapter.archiveSession;
  const originalUnarchiveSession = adapter.unarchiveSession;
  const originalDeleteSession = adapter.deleteSession;
  const archiveCalls: MeshAgentProviderSessionLifecycleContext[] = [];
  const unarchiveCalls: MeshAgentProviderSessionLifecycleContext[] = [];
  const deleteCalls: MeshAgentProviderSessionLifecycleContext[] = [];
  adapter.archiveSession = async (context) => {
    archiveCalls.push(context);
  };
  adapter.unarchiveSession = async (context) => {
    unarchiveCalls.push(context);
  };
  adapter.deleteSession = async (context) => {
    deleteCalls.push(context);
  };

  try {
    const { projectId } = await d.session.createProject({ title: 'p' });
    const { sessionId } = await d.session.createProjectSession({ projectId, title: 'project session' });
    const now = '2026-07-20T00:00:00.000Z';
    store.upsertMeshSession({
      id: 'mesh_lifecycle000',
      transcriptTargetId: sessionId,
      agentName: 'pmem_codex',
      provider: 'codex',
      workingPath: '/tmp/project',
      runtimeRole: 'managed-project-agent',
      agentRuntimeId: null,
      agentRuntimeTokenHash: null,
      lastDeliveredSeq: 0,
      lastVisibleSeq: 0,
      state: 'running',
      pid: null,
      providerSessionRef: 'thread_codex_123',
      outputSnapshot: '',
      exitCode: null,
      startedAt: now,
      updatedAt: now,
      exitedAt: null
    });

    await d.session.update({ id: sessionId, archived: true });
    await d.session.update({ id: sessionId, archived: true });
    expect(archiveCalls).toEqual([
      expect.objectContaining({
        meshSessionId: 'mesh_lifecycle000',
        transcriptTargetId: sessionId,
        agentName: 'pmem_codex',
        agent: expect.objectContaining({ name: 'pmem_codex', provider: 'codex' }),
        providerSessionRef: 'thread_codex_123',
        workingPath: '/tmp/project'
      })
    ]);

    await d.session.update({ id: sessionId, archived: false });
    await d.session.update({ id: sessionId, archived: false });
    expect(unarchiveCalls).toEqual([
      expect.objectContaining({
        meshSessionId: 'mesh_lifecycle000',
        transcriptTargetId: sessionId,
        agentName: 'pmem_codex',
        agent: expect.objectContaining({ name: 'pmem_codex', provider: 'codex' }),
        providerSessionRef: 'thread_codex_123',
        workingPath: '/tmp/project'
      })
    ]);

    await d.session.delete({ id: sessionId });
    expect(deleteCalls).toEqual([]);
    await waitFor(() => deleteCalls.length === 1, {
      message: 'project session provider deletion was not applied'
    });
    expect(deleteCalls).toEqual([
      expect.objectContaining({
        meshSessionId: 'mesh_lifecycle000',
        transcriptTargetId: sessionId,
        agentName: 'pmem_codex',
        agent: expect.objectContaining({ name: 'pmem_codex', provider: 'codex' }),
        providerSessionRef: 'thread_codex_123',
        workingPath: '/tmp/project'
      })
    ]);
  } finally {
    adapter.archiveSession = originalArchiveSession;
    adapter.unarchiveSession = originalUnarchiveSession;
    adapter.deleteSession = originalDeleteSession;
    store.close();
  }
});

test('non-project session archive, unarchive, and delete apply matching provider lifecycle hooks', async () => {
  const store = createStore();
  const d = buildHandlers(mockModel(['hi']), undefined, { store, sessionDeleteGraceMs: 1 });
  const adapter = getMeshAgentProviderAdapter('codex');
  const originalArchiveSession = adapter.archiveSession;
  const originalUnarchiveSession = adapter.unarchiveSession;
  const originalDeleteSession = adapter.deleteSession;
  const archiveCalls: MeshAgentProviderSessionLifecycleContext[] = [];
  const unarchiveCalls: MeshAgentProviderSessionLifecycleContext[] = [];
  const deleteCalls: MeshAgentProviderSessionLifecycleContext[] = [];
  adapter.archiveSession = async (context) => {
    archiveCalls.push(context);
  };
  adapter.unarchiveSession = async (context) => {
    unarchiveCalls.push(context);
  };
  adapter.deleteSession = async (context) => {
    deleteCalls.push(context);
  };

  try {
    const { sessionId } = await d.session.create({ title: 'native chat' });
    const now = '2026-07-23T00:00:00.000Z';
    store.upsertMeshSession({
      id: 'mesh_chatunarchive',
      transcriptTargetId: sessionId,
      agentName: 'pmem_codex_chat',
      provider: 'codex',
      workingPath: '/tmp/native-chat',
      runtimeRole: 'interactive',
      agentRuntimeId: null,
      agentRuntimeTokenHash: null,
      lastDeliveredSeq: 0,
      lastVisibleSeq: 0,
      state: 'stopped',
      pid: null,
      providerSessionRef: 'thread_codex_chat',
      outputSnapshot: '',
      exitCode: null,
      startedAt: now,
      updatedAt: now,
      exitedAt: now
    });

    await d.session.update({ id: sessionId, archived: true });
    await d.session.update({ id: sessionId, archived: false });
    await d.session.update({ id: sessionId, archived: false });

    expect(archiveCalls).toEqual([
      expect.objectContaining({
        meshSessionId: 'mesh_chatunarchive',
        transcriptTargetId: sessionId,
        agentName: 'pmem_codex_chat',
        agent: expect.objectContaining({ name: 'pmem_codex_chat', provider: 'codex' }),
        providerSessionRef: 'thread_codex_chat',
        workingPath: '/tmp/native-chat'
      })
    ]);
    expect(unarchiveCalls).toEqual([
      expect.objectContaining({
        meshSessionId: 'mesh_chatunarchive',
        transcriptTargetId: sessionId,
        agentName: 'pmem_codex_chat',
        agent: expect.objectContaining({ name: 'pmem_codex_chat', provider: 'codex' }),
        providerSessionRef: 'thread_codex_chat',
        workingPath: '/tmp/native-chat'
      })
    ]);
    await d.session.delete({ id: sessionId });
    await waitFor(() => deleteCalls.length === 1, {
      message: 'non-project session provider deletion was not applied'
    });
    expect(deleteCalls).toEqual([
      expect.objectContaining({
        meshSessionId: 'mesh_chatunarchive',
        transcriptTargetId: sessionId,
        agentName: 'pmem_codex_chat',
        agent: expect.objectContaining({ name: 'pmem_codex_chat', provider: 'codex' }),
        providerSessionRef: 'thread_codex_chat',
        workingPath: '/tmp/native-chat'
      })
    ]);
  } finally {
    adapter.archiveSession = originalArchiveSession;
    adapter.unarchiveSession = originalUnarchiveSession;
    adapter.deleteSession = originalDeleteSession;
    store.close();
  }
});

test('session archive preserves local state when the provider transition fails', async () => {
  const store = createStore();
  const d = buildHandlers(mockModel(['hi']), undefined, { store });
  const adapter = getMeshAgentProviderAdapter('codex');
  const originalArchiveSession = adapter.archiveSession;
  adapter.archiveSession = async () => {
    throw new Error('provider archive failed');
  };

  try {
    const { sessionId } = await d.session.create({ title: 'native chat' });
    const now = '2026-07-23T00:00:00.000Z';
    store.upsertMeshSession({
      id: 'mesh_archivefail0',
      transcriptTargetId: sessionId,
      agentName: 'pmem_codex_chat',
      provider: 'codex',
      workingPath: '/tmp/native-chat',
      runtimeRole: 'interactive',
      agentRuntimeId: null,
      agentRuntimeTokenHash: null,
      lastDeliveredSeq: 0,
      lastVisibleSeq: 0,
      state: 'stopped',
      pid: null,
      providerSessionRef: 'thread_archive_failure',
      outputSnapshot: '',
      exitCode: null,
      startedAt: now,
      updatedAt: now,
      exitedAt: now
    });

    await expect(d.session.update({ id: sessionId, archived: true })).rejects.toThrow('provider archive failed');
    expect(store.getSession(sessionId)?.archived).toBe(false);
  } finally {
    adapter.archiveSession = originalArchiveSession;
    store.close();
  }
});

test('project deletion applies provider deletion before removing project session storage', async () => {
  const store = createStore();
  const d = buildHandlers(mockModel(['hi']), undefined, { store });
  const adapter = getMeshAgentProviderAdapter('codex');
  const originalDeleteSession = adapter.deleteSession;
  const deleteCalls: MeshAgentProviderSessionLifecycleContext[] = [];
  adapter.deleteSession = async (context) => {
    deleteCalls.push(context);
  };

  try {
    const { projectId } = await d.session.createProject({ title: 'p' });
    const { sessionId } = await d.session.createProjectSession({ projectId, title: 'project session' });
    const now = '2026-07-20T00:00:00.000Z';
    store.upsertMeshSession({
      id: 'mesh_projectdel00',
      transcriptTargetId: sessionId,
      agentName: 'pmem_codex',
      provider: 'codex',
      workingPath: '/tmp/project',
      runtimeRole: 'managed-project-agent',
      agentRuntimeId: null,
      agentRuntimeTokenHash: null,
      lastDeliveredSeq: 0,
      lastVisibleSeq: 0,
      state: 'running',
      pid: null,
      providerSessionRef: 'thread_project_delete',
      outputSnapshot: '',
      exitCode: null,
      startedAt: now,
      updatedAt: now,
      exitedAt: null
    });

    await d.session.deleteProject({ id: projectId });

    expect(deleteCalls).toEqual([
      expect.objectContaining({
        meshSessionId: 'mesh_projectdel00',
        transcriptTargetId: sessionId,
        agentName: 'pmem_codex',
        agent: expect.objectContaining({ name: 'pmem_codex', provider: 'codex' }),
        providerSessionRef: 'thread_project_delete',
        workingPath: '/tmp/project'
      })
    ]);
    expect({ project: store.getWorkplaceProject(projectId), session: store.getSession(sessionId) }).toEqual({
      project: null,
      session: null
    });
  } finally {
    adapter.deleteSession = originalDeleteSession;
    store.close();
  }
});

test('project deletion removes local storage when provider deletion fails', async () => {
  const store = createStore();
  const d = buildHandlers(mockModel(['hi']), undefined, { store });
  const adapter = getMeshAgentProviderAdapter('codex');
  const originalDeleteSession = adapter.deleteSession;
  adapter.deleteSession = async () => {
    throw new Error('provider delete failed');
  };

  try {
    const { projectId } = await d.session.createProject({ title: 'p' });
    const { sessionId } = await d.session.createProjectSession({ projectId, title: 'project session' });
    const now = '2026-07-20T00:00:00.000Z';
    store.upsertMeshSession({
      id: 'mesh_deletefail00',
      transcriptTargetId: sessionId,
      agentName: 'pmem_codex',
      provider: 'codex',
      workingPath: '/tmp/project',
      runtimeRole: 'managed-project-agent',
      agentRuntimeId: null,
      agentRuntimeTokenHash: null,
      lastDeliveredSeq: 0,
      lastVisibleSeq: 0,
      state: 'stopped',
      pid: null,
      providerSessionRef: 'thread_delete_failure',
      outputSnapshot: '',
      exitCode: null,
      startedAt: now,
      updatedAt: now,
      exitedAt: now
    });

    await d.session.deleteProject({ id: projectId });
    expect({ project: store.getWorkplaceProject(projectId), session: store.getSession(sessionId) }).toEqual({
      project: null,
      session: null
    });
  } finally {
    adapter.deleteSession = originalDeleteSession;
    store.close();
  }
});

test('stopped native session deletion removes the Monad session when provider deletion fails', async () => {
  const store = createStore();
  const d = buildHandlers(mockModel(['hi']), undefined, { store, sessionDeleteGraceMs: 1 });
  const adapter = getMeshAgentProviderAdapter('codex');
  const originalDeleteSession = adapter.deleteSession;
  adapter.deleteSession = async () => {
    throw new Error('provider delete failed');
  };

  try {
    const { sessionId } = await d.session.create({ title: 'stopped native session' });
    const now = '2026-08-19T00:00:00.000Z';
    const meshSessionId = 'mesh_stoppeddelete';
    store.upsertMeshSession({
      id: meshSessionId,
      transcriptTargetId: sessionId,
      agentName: 'pmem_codex_stopped',
      provider: 'codex',
      workingPath: '/tmp/stopped-native-session',
      runtimeRole: 'interactive',
      agentRuntimeId: null,
      agentRuntimeTokenHash: null,
      lastDeliveredSeq: 0,
      lastVisibleSeq: 0,
      state: 'stopped',
      pid: null,
      providerSessionRef: 'thread_stopped_delete_failure',
      outputSnapshot: '',
      exitCode: 0,
      startedAt: now,
      updatedAt: now,
      exitedAt: now
    });

    await d.session.delete({ id: sessionId });
    await waitFor(() => store.getMeshSession(meshSessionId) === null && store.getSession(sessionId) === null, {
      message: 'stopped native session storage was not deleted'
    });

    expect({ meshSession: store.getMeshSession(meshSessionId), session: store.getSession(sessionId) }).toEqual({
      meshSession: null,
      session: null
    });
  } finally {
    adapter.deleteSession = originalDeleteSession;
    store.close();
  }
});

test('project deletion preserves storage when child runtime teardown fails', async () => {
  const store = createStore();
  const hooks: Hooks = {
    run: async (input) => {
      if (input.event === 'SessionEnd') throw new Error('session teardown failed');
      return { blocked: false, ask: false, allowed: false, additionalContext: [] };
    }
  };
  const d = buildHandlers(mockModel(['hi']), undefined, { hooks, store });

  try {
    const { projectId } = await d.session.createProject({ title: 'p' });
    const { sessionId } = await d.session.createProjectSession({ projectId, title: 'project session' });

    await expect(d.session.deleteProject({ id: projectId })).rejects.toThrow('session teardown failed');
    expect({ project: store.getWorkplaceProject(projectId)?.id, session: store.getSession(sessionId)?.id }).toEqual({
      project: projectId,
      session: sessionId
    });
  } finally {
    store.close();
  }
});

test('createProjectSession requires project members to be invited manually', async () => {
  const store = createStore();
  const d = buildHandlers(mockModel(['hi']), undefined, { store });
  const { projectId } = await d.session.createProject({ title: 'p' });
  await d.session.updateProject({
    id: projectId,
    memberTemplates: [
      {
        id: 'pmem_codex',
        type: 'mesh-agent',
        name: 'codex',
        displayName: 'Lily',
        settings: { managedProjectAgent: true }
      }
    ]
  });

  const { sessionId } = await d.session.createProjectSession({ projectId, title: 'project session' });

  expect(store.listSessionMembers(sessionId)).toEqual([]);
  await d.session.inviteSessionMember({ sessionId, templateId: 'pmem_codex' });
  expect(store.listSessionMembers(sessionId).map((member) => member.templateId)).toEqual(['pmem_codex']);
  store.close();
});

test('a manually populated project session keeps its roster when project members change', async () => {
  const store = createStore();
  const d = buildHandlers(mockModel(['hi']), undefined, { store });
  const { projectId } = await d.session.createProject({ title: 'manual roster' });
  const fable = {
    id: 'pmem_fable',
    type: 'mesh-agent' as const,
    name: 'claude-code',
    displayName: 'Fable',
    settings: { managedProjectAgent: true, modelId: 'fable' }
  };
  await d.session.updateProject({ id: projectId, memberTemplates: [fable] });

  const { sessionId } = await d.session.createProjectSession({ projectId, title: 'Kanban task' });
  expect(store.listSessionMembers(sessionId)).toEqual([]);

  await d.session.inviteSessionMember({ sessionId, templateId: fable.id });
  const fableEdited = { ...fable, displayName: 'Fable Prime' };
  const opus = {
    id: 'pmem_opus',
    type: 'mesh-agent' as const,
    name: 'claude-code',
    displayName: 'Opus',
    settings: { managedProjectAgent: true, modelId: 'opus' }
  };
  await d.session.updateProject({ id: projectId, memberTemplates: [fableEdited, opus] });

  expect(
    store.listSessionMembers(sessionId).map((member) => ({
      memberIdIsDistinct: member.memberId !== member.templateId,
      templateId: member.templateId,
      data: member.data
    }))
  ).toEqual([
    {
      memberIdIsDistinct: true,
      templateId: 'pmem_fable',
      data: {
        name: 'claude-code',
        displayName: 'Fable',
        settings: { managedProjectAgent: true, modelId: 'fable' }
      }
    }
  ]);
  store.close();
});

test('project member updates leave every existing session roster unchanged', async () => {
  const store = createStore();
  const d = buildHandlers(mockModel(['hi']), undefined, { store });
  const { projectId } = await d.session.createProject({ title: 'p' });
  const fable = {
    id: 'pmem_fable',
    type: 'mesh-agent' as const,
    name: 'claude-code',
    displayName: 'Fable',
    settings: { managedProjectAgent: true, modelId: 'fable' }
  };
  const gpt = {
    id: 'pmem_gpt',
    type: 'mesh-agent' as const,
    name: 'codex',
    displayName: 'GPT',
    settings: { managedProjectAgent: true, modelId: 'gpt-old' }
  };
  await d.session.updateProject({ id: projectId, memberTemplates: [fable, gpt] });
  const { sessionId: activeId } = await d.session.createProjectSession({ projectId, title: 'active' });
  const { sessionId: completedId } = await d.session.createProjectSession({ projectId, title: 'completed' });
  const { sessionId: archivedId } = await d.session.createProjectSession({ projectId, title: 'archived' });
  for (const sessionId of [activeId, completedId, archivedId]) {
    await d.session.inviteSessionMember({ sessionId, templateId: fable.id });
    await d.session.inviteSessionMember({ sessionId, templateId: gpt.id });
  }
  await d.session.update({ id: completedId, state: 'completed' });
  await d.session.update({ id: archivedId, archived: true });
  const now = new Date().toISOString();
  store.insertSessionMember({
    sessionId: activeId,
    memberId: 'pmem_ad_hoc',
    templateId: null,
    type: 'mesh-agent',
    data: { name: 'gemini', displayName: 'Ad hoc' },
    createdAt: now,
    updatedAt: now
  });
  const legacyMessageId = newId('msg');
  store.insertMessage(legacyMessageId, activeId, 'legacy Fable response', now, 'assistant', {
    data: { agentName: fable.id, source: 'managed-mesh-agent' }
  });
  const gptEdited = {
    ...gpt,
    displayName: 'GPT 5.6 SOL',
    settings: { managedProjectAgent: true, modelId: 'gpt-5.6-sol' }
  };
  const opus = {
    id: 'pmem_opus',
    type: 'mesh-agent' as const,
    name: 'claude-code',
    displayName: 'Opus',
    settings: { managedProjectAgent: true, modelId: 'opus' }
  };

  await d.session.updateProject({ id: projectId, memberTemplates: [gptEdited, opus] });
  await d.session.updateProject({ id: projectId, memberTemplates: [gptEdited, opus] });

  const memberContract = (member: ReturnType<typeof store.listSessionMembers>[number]) => ({
    ...(member.templateId
      ? { memberIdIsDistinct: member.memberId !== member.templateId }
      : { memberId: member.memberId }),
    templateId: member.templateId,
    type: member.type,
    data: member.data
  });
  expect(store.listSessionMembers(activeId).map(memberContract)).toEqual([
    {
      memberIdIsDistinct: true,
      templateId: 'pmem_fable',
      type: 'mesh-agent',
      data: {
        name: 'claude-code',
        displayName: 'Fable',
        settings: { managedProjectAgent: true, modelId: 'fable' }
      }
    },
    {
      memberIdIsDistinct: true,
      templateId: 'pmem_gpt',
      type: 'mesh-agent',
      data: {
        name: 'codex',
        displayName: 'GPT',
        settings: { managedProjectAgent: true, modelId: 'gpt-old' }
      }
    },
    {
      memberId: 'pmem_ad_hoc',
      templateId: null,
      type: 'mesh-agent',
      data: { name: 'gemini', displayName: 'Ad hoc' }
    }
  ]);
  const originalRoster = [
    {
      memberIdIsDistinct: true,
      templateId: 'pmem_fable',
      type: 'mesh-agent',
      data: {
        name: 'claude-code',
        displayName: 'Fable',
        settings: { managedProjectAgent: true, modelId: 'fable' }
      }
    },
    {
      memberIdIsDistinct: true,
      templateId: 'pmem_gpt',
      type: 'mesh-agent',
      data: {
        name: 'codex',
        displayName: 'GPT',
        settings: { managedProjectAgent: true, modelId: 'gpt-old' }
      }
    }
  ];
  expect(store.listSessionMembers(completedId).map(memberContract)).toEqual(originalRoster);
  expect(store.listSessionMembers(archivedId).map(memberContract)).toEqual(originalRoster);
  expect(store.getMessage(activeId, legacyMessageId)?.data).toEqual({
    agentName: 'pmem_fable',
    source: 'managed-mesh-agent'
  });
  store.close();
});

test('sessionAbort reports false when nothing is in flight', async () => {
  const d = buildHandlers(mockModel(['hi']));
  const { sessionId } = await d.session.create({ title: 't' });
  expect(await d.session.abort({ id: sessionId })).toEqual({ aborted: false });
});

test('sessionMessages returns persisted history after a block turn', async () => {
  const d = buildHandlers(mockModel(['Hello', ' world']));
  const { sessionId } = await d.session.create({ title: 't' });
  await d.session.generate({ sessionId, text: 'hi' });
  const { messages } = await d.session.messages({ id: sessionId });
  expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  expect(messages[1]?.text).toBe('Hello world');
});
