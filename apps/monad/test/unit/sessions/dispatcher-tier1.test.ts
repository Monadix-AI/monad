import type { SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { HandlerError } from '#/handlers/handler-error.ts';
import { createStore } from '#/store/db/index.ts';
import { buildHandlers, mockModel } from '../../helpers.ts';

test('sessionGet throws INVALID_PARAMS for an unknown session', async () => {
  const d = buildHandlers(mockModel(['hi']));
  await expect(d.session.get({ id: 'ses_nope00000000' as SessionId })).rejects.toBeInstanceOf(HandlerError);
  try {
    await d.session.get({ id: 'ses_nope00000000' as SessionId });
  } catch (e) {
    expect((e as HandlerError).kind).toBe('invalid');
  }
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

test('createProjectSession clones the project member templates into live session members', async () => {
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

  expect(store.listSessionMembers(sessionId)).toMatchObject([
    {
      memberId: 'pmem_codex',
      templateId: 'pmem_codex',
      type: 'mesh-agent',
      data: {
        name: 'codex',
        displayName: 'Lily',
        settings: { managedProjectAgent: true }
      }
    }
  ]);
  store.close();
});

test('project member updates reconcile active bindings and add each new template once', async () => {
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
    memberId: member.memberId,
    templateId: member.templateId,
    type: member.type,
    data: member.data
  });
  expect(store.listSessionMembers(activeId).map(memberContract)).toEqual([
    {
      memberId: 'pmem_gpt',
      templateId: 'pmem_gpt',
      type: 'mesh-agent',
      data: {
        name: 'codex',
        displayName: 'GPT 5.6 SOL',
        settings: { managedProjectAgent: true, modelId: 'gpt-5.6-sol' }
      }
    },
    {
      memberId: 'pmem_ad_hoc',
      templateId: null,
      type: 'mesh-agent',
      data: { name: 'gemini', displayName: 'Ad hoc' }
    },
    {
      memberId: 'pmem_opus',
      templateId: 'pmem_opus',
      type: 'mesh-agent',
      data: {
        name: 'claude-code',
        displayName: 'Opus',
        settings: { managedProjectAgent: true, modelId: 'opus' }
      }
    }
  ]);
  const originalRoster = [
    {
      memberId: 'pmem_fable',
      templateId: 'pmem_fable',
      type: 'mesh-agent',
      data: {
        name: 'claude-code',
        displayName: 'Fable',
        settings: { managedProjectAgent: true, modelId: 'fable' }
      }
    },
    {
      memberId: 'pmem_gpt',
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
    agentDisplayName: 'Fable',
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
