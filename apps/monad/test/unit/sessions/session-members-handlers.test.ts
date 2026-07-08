import type { Session, SessionId, WorkplaceProject, WorkplaceProjectMemberTemplate } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { HandlerError } from '#/handlers/handler-error.ts';
import { createSessionMembersHandlers } from '#/handlers/session/handlers/session-members.ts';
import { createStore } from '#/store/db/index.ts';

// spawnIfManaged (session-members.ts) requires a real config file match to reach
// spawnManagedSessionMember at all — that resolution path is exercised by the existing
// managed-external-agent-join/delivery tests. These tests cover the new handler logic itself:
// CRUD, guard rails, and — via a direct store assertion — that a successful spawn's
// externalAgentSessionId is persisted onto the *session-scoped* row, never shared across sessions.

function fixtureSession(store: ReturnType<typeof createStore>, over: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  const session: Session = {
    id: newId('ses'),
    title: 'test',
    ownerPrincipalId: newId('prn'),
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
    createdAt: now,
    updatedAt: now,
    ...over
  };
  store.insertSession(session);
  return session;
}

function fixtureProject(store: ReturnType<typeof createStore>, over: Partial<WorkplaceProject> = {}): WorkplaceProject {
  const now = new Date().toISOString();
  const project: WorkplaceProject = {
    id: newId('prj'),
    title: 'project',
    ownerPrincipalId: newId('prn'),
    state: 'active',
    archived: false,
    memberTemplates: [],
    createdAt: now,
    updatedAt: now,
    ...over
  };
  store.insertWorkplaceProject(project);
  return project;
}

function buildHarness(store: ReturnType<typeof createStore>) {
  const stopCalls: string[] = [];
  const ctx = {
    deps: {
      store,
      paths: undefined,
      externalAgentHost: { stop: (id: string) => stopCalls.push(id) }
    },
    requireSession: (id: SessionId) => {
      const session = store.getSession(id);
      if (!session) throw new HandlerError('invalid', `session not found: ${id}`);
      return session;
    }
  } as unknown as SessionContext;
  // paths is undefined, so spawnIfManaged no-ops after the insert — these tests assert the CRUD/guard
  // behavior of the handlers themselves.
  const handlers = createSessionMembersHandlers(ctx, {
    spawnManagedSessionMember: async () => ({ started: false })
  });
  return { handlers, stopCalls };
}

const codexTemplate: WorkplaceProjectMemberTemplate = {
  id: 'tmpl_codex',
  type: 'external-agent',
  name: 'codex',
  displayName: 'Codex'
};

test('inviteSessionMember creates a session_members row from a project memberTemplate', async () => {
  const store = createStore();
  const project = fixtureProject(store, { memberTemplates: [codexTemplate] });
  const session = fixtureSession(store, { projectId: project.id });
  const { handlers } = buildHarness(store);

  const { member } = await handlers.inviteSessionMember({ sessionId: session.id, templateId: codexTemplate.id });

  expect(member).toMatchObject({
    id: codexTemplate.id,
    templateId: codexTemplate.id,
    type: 'external-agent',
    name: 'codex',
    displayName: 'Codex'
  });
  expect(store.listSessionMembers(session.id)).toHaveLength(1);
});

test('inviteSessionMember throws not_found for an unknown template', async () => {
  const store = createStore();
  const project = fixtureProject(store);
  const session = fixtureSession(store, { projectId: project.id });
  const { handlers } = buildHarness(store);

  await expect(handlers.inviteSessionMember({ sessionId: session.id, templateId: 'tmpl_missing' })).rejects.toThrow(
    HandlerError
  );
});

test('inviteSessionMember rejects a session with no project', async () => {
  const store = createStore();
  const session = fixtureSession(store);
  const { handlers } = buildHarness(store);

  await expect(handlers.inviteSessionMember({ sessionId: session.id, templateId: 'tmpl_codex' })).rejects.toThrow(
    HandlerError
  );
});

test('inviteSessionMember rejects inviting the same template twice into one session', async () => {
  const store = createStore();
  const project = fixtureProject(store, { memberTemplates: [codexTemplate] });
  const session = fixtureSession(store, { projectId: project.id });
  const { handlers } = buildHarness(store);

  await handlers.inviteSessionMember({ sessionId: session.id, templateId: codexTemplate.id });
  await expect(handlers.inviteSessionMember({ sessionId: session.id, templateId: codexTemplate.id })).rejects.toThrow(
    HandlerError
  );
});

test('inviting the same template into two different sessions produces two independent bindings', async () => {
  const store = createStore();
  const project = fixtureProject(store, { memberTemplates: [codexTemplate] });
  const sessionA = fixtureSession(store, { projectId: project.id });
  const sessionB = fixtureSession(store, { projectId: project.id });
  const { handlers } = buildHarness(store);

  await handlers.inviteSessionMember({ sessionId: sessionA.id, templateId: codexTemplate.id });
  await handlers.inviteSessionMember({ sessionId: sessionB.id, templateId: codexTemplate.id });

  // Each session's own session_members row — never shared. Simulate what a successful spawn would
  // persist for each (spawnIfManaged writes exactly this shape via store.updateSessionMember).
  store.updateSessionMember(sessionA.id, codexTemplate.id, {
    externalAgentSessionId: 'exa_a',
    updatedAt: new Date().toISOString()
  });
  store.updateSessionMember(sessionB.id, codexTemplate.id, {
    externalAgentSessionId: 'exa_b',
    updatedAt: new Date().toISOString()
  });

  expect(store.getSessionMember(sessionA.id, codexTemplate.id)?.externalAgentSessionId).toBe('exa_a');
  expect(store.getSessionMember(sessionB.id, codexTemplate.id)?.externalAgentSessionId).toBe('exa_b');
});

test('spawnSessionMember creates an ad-hoc member with no templateId and never touches memberTemplates', async () => {
  const store = createStore();
  const project = fixtureProject(store);
  const session = fixtureSession(store, { projectId: project.id });
  const { handlers } = buildHarness(store);

  const { member } = await handlers.spawnSessionMember({
    sessionId: session.id,
    type: 'external-agent',
    name: 'claude-code',
    displayName: 'Ad hoc Claude'
  });

  expect(member.templateId).toBeUndefined();
  expect(member.name).toBe('claude-code');
  expect(store.getWorkplaceProject(project.id)?.memberTemplates).toEqual([]);
});

test('removeSessionMember stops the runtime when bound and deletes the row', async () => {
  const store = createStore();
  const project = fixtureProject(store, { memberTemplates: [codexTemplate] });
  const session = fixtureSession(store, { projectId: project.id });
  const { handlers, stopCalls } = buildHarness(store);

  await handlers.inviteSessionMember({ sessionId: session.id, templateId: codexTemplate.id });
  store.updateSessionMember(session.id, codexTemplate.id, {
    externalAgentSessionId: 'exa_running',
    updatedAt: new Date().toISOString()
  });

  const result = await handlers.removeSessionMember({ sessionId: session.id, memberId: codexTemplate.id });

  expect(result).toEqual({ deleted: true });
  expect(stopCalls).toEqual(['exa_running']);
  expect(store.listSessionMembers(session.id)).toEqual([]);
});

test('removeSessionMember throws not_found for an unknown member', async () => {
  const store = createStore();
  const session = fixtureSession(store);
  const { handlers } = buildHarness(store);

  await expect(handlers.removeSessionMember({ sessionId: session.id, memberId: 'nope' })).rejects.toThrow(HandlerError);
});

test('listSessionMembers returns the wire shape for every bound member', async () => {
  const store = createStore();
  const project = fixtureProject(store, { memberTemplates: [codexTemplate] });
  const session = fixtureSession(store, { projectId: project.id });
  const { handlers } = buildHarness(store);

  await handlers.inviteSessionMember({ sessionId: session.id, templateId: codexTemplate.id });
  await handlers.spawnSessionMember({ sessionId: session.id, type: 'acp', name: 'ad-hoc-acp' });

  const { members } = await handlers.listSessionMembers({ sessionId: session.id });
  expect(members.map((m) => m.name).sort()).toEqual(['ad-hoc-acp', 'codex']);
});
