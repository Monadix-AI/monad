import type { Session, WorkplaceProject } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { syncSessionMembersFromProjectTemplates } from '@/handlers/session/handlers/session-member-sync.ts';
import { createStore } from '@/store/db/index.ts';

function fixtureSession(over: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  return {
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
}

function fixtureProject(over: Partial<WorkplaceProject> = {}): WorkplaceProject {
  const now = new Date().toISOString();
  return {
    id: newId('prj'),
    title: 'project',
    ownerPrincipalId: newId('prn'),
    state: 'active',
    archived: false,
    createdAt: now,
    updatedAt: now,
    ...over
  };
}

const memberOrigin = (members: unknown[]) => ({
  surface: 'web' as const,
  client: 'workplace',
  transport: 'http' as const,
  writableBy: ['http' as const],
  branchableBy: ['http' as const],
  ext: { workplaceProjectMembers: members }
});

test('syncSessionMembersFromProjectTemplates is a no-op for a session with no projectId', () => {
  const store = createStore();
  const session = fixtureSession();
  store.insertSession(session);
  syncSessionMembersFromProjectTemplates(store, session);
  expect(store.listSessionMembers(session.id)).toEqual([]);
});

test('syncSessionMembersFromProjectTemplates inserts a session_members row per project member template', () => {
  const store = createStore();
  const project = fixtureProject({
    origin: memberOrigin([{ type: 'external-agent', name: 'codex', instanceId: 'pmem_codex_a', displayName: 'A' }])
  });
  store.insertWorkplaceProject(project);
  const session = fixtureSession({ projectId: project.id });
  store.insertSession(session);

  syncSessionMembersFromProjectTemplates(store, session);

  const members = store.listSessionMembers(session.id);
  expect(members).toHaveLength(1);
  expect(members[0]).toMatchObject({
    sessionId: session.id,
    memberId: 'pmem_codex_a',
    templateId: 'pmem_codex_a',
    type: 'external-agent',
    externalAgentSessionId: null,
    data: { name: 'codex', instanceId: 'pmem_codex_a', displayName: 'A' }
  });
});

test('syncSessionMembersFromProjectTemplates removes a session member whose template was deleted from the roster', () => {
  const store = createStore();
  const project = fixtureProject({
    origin: memberOrigin([{ type: 'external-agent', name: 'codex', instanceId: 'pmem_codex_a' }])
  });
  store.insertWorkplaceProject(project);
  const session = fixtureSession({ projectId: project.id });
  store.insertSession(session);
  syncSessionMembersFromProjectTemplates(store, session);
  expect(store.listSessionMembers(session.id)).toHaveLength(1);

  store.updateWorkplaceProject(project.id, { origin: memberOrigin([]) });
  syncSessionMembersFromProjectTemplates(store, session);

  expect(store.listSessionMembers(session.id)).toEqual([]);
});

test('syncSessionMembersFromProjectTemplates preserves an existing externalAgentSessionId binding across resync', () => {
  const store = createStore();
  const project = fixtureProject({
    origin: memberOrigin([{ type: 'external-agent', name: 'codex', instanceId: 'pmem_codex_a' }])
  });
  store.insertWorkplaceProject(project);
  const session = fixtureSession({ projectId: project.id });
  store.insertSession(session);
  syncSessionMembersFromProjectTemplates(store, session);
  store.updateSessionMember(session.id, 'pmem_codex_a', {
    externalAgentSessionId: 'exa_running',
    updatedAt: new Date().toISOString()
  });

  syncSessionMembersFromProjectTemplates(store, session);

  const [member] = store.listSessionMembers(session.id);
  expect(member?.externalAgentSessionId).toBe('exa_running');
});
