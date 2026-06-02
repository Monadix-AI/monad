import type { MeshAgentConfig } from '@monad/environment';
import type {
  AgentId,
  OperationSource,
  Session,
  SessionId,
  WorkplaceProject,
  WorkplaceProjectMemberTemplate
} from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { HandlerError } from '#/handlers/handler-error.ts';
import { createSessionMembersHandlers } from '#/handlers/session/handlers/session-members.ts';
import { createStore } from '#/store/db/index.ts';

// spawnIfManaged (session-members.ts) requires a real config file match to reach
// spawnManagedSessionMember at all — that resolution path is exercised by the existing
// managed-mesh-agent-join/delivery tests. These tests cover the new handler logic itself:
// CRUD, guard rails, and — via a direct store assertion — that a successful spawn's
// meshSessionId is persisted onto the *session-scoped* row, never shared across sessions.

function fixtureSession(store: ReturnType<typeof createStore>, over: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  const session: Session = {
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
  store.insertSession(session);
  return session;
}

function fixtureProject(store: ReturnType<typeof createStore>, over: Partial<WorkplaceProject> = {}): WorkplaceProject {
  const now = new Date().toISOString();
  const project: WorkplaceProject = {
    id: newId('prj'),
    title: 'project',
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

function buildHarness(
  store: ReturnType<typeof createStore>,
  meshAgentsOrOptions:
    | MeshAgentConfig[]
    | {
        stop?: (id: string) => void;
      } = [
    {
      name: 'codex',
      displayName: 'Codex',
      provider: 'codex',
      command: 'codex',
      enabled: true,
      allowAutopilot: true,
      approvalOwnership: 'provider-owned'
    }
  ],
  monadAgents: Array<{ id: AgentId; name: string }> = []
) {
  const options = Array.isArray(meshAgentsOrOptions) ? {} : meshAgentsOrOptions;
  const meshAgents = Array.isArray(meshAgentsOrOptions)
    ? meshAgentsOrOptions
    : [
        {
          name: 'codex',
          displayName: 'Codex',
          provider: 'codex' as const,
          command: 'codex',
          enabled: true,
          allowAutopilot: true,
          approvalOwnership: 'provider-owned' as const
        }
      ];
  const stopCalls: string[] = [];
  const stop =
    options.stop ??
    ((id: string) => {
      stopCalls.push(id);
    });
  const ctx = {
    deps: {
      store,
      paths: undefined,
      configManager: {
        get: () => ({ cfg: { meshAgents, agent: { agents: monadAgents } } })
      },
      meshAgentHost: { stop }
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
  type: 'mesh-agent',
  name: 'codex',
  displayName: 'Codex'
};

test('inviteSessionMember creates a session_members row from a project memberTemplate', async () => {
  const store = createStore();
  try {
    const project = fixtureProject(store, { memberTemplates: [codexTemplate] });
    const session = fixtureSession(store, { projectId: project.id });
    const { handlers } = buildHarness(store);

    const result = await handlers.inviteSessionMember({ sessionId: session.id, templateId: codexTemplate.id });
    const stored = store.getSessionMemberByTemplate(session.id, codexTemplate.id);
    if (!stored) throw new Error('expected stored session member');

    // Canonical response: the ProjectMember identity (fresh per-instance id, profileId = template.id)
    // joined with a freshly minted active session binding at cursor 0. No legacy wire projection.
    expect(stored.memberId).toMatch(/^pmem_/);
    expect(result).toEqual({
      member: {
        id: stored.memberId,
        projectId: project.id,
        profileId: codexTemplate.id,
        type: 'mesh-agent',
        displayName: 'Codex',
        customPrompt: null,
        launchOverrides: {},
        workingDirectoryOverride: null,
        lifecycle: 'enabled',
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt
      },
      binding: {
        sessionId: session.id,
        projectMemberId: stored.memberId,
        lastDeliveredSeq: 0,
        lastVisibleSeq: 0,
        currentNativeRuntimeSessionId: null,
        lifecycle: 'active',
        lastHealth: null,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt
      }
    });
    expect(store.listSessionMembers(session.id)).toHaveLength(1);
  } finally {
    store.close();
  }
});

test('inviteSessionMember throws not_found for an unknown template', async () => {
  const store = createStore();
  try {
    const project = fixtureProject(store);
    const session = fixtureSession(store, { projectId: project.id });
    const { handlers } = buildHarness(store);

    await expect(handlers.inviteSessionMember({ sessionId: session.id, templateId: 'tmpl_missing' })).rejects.toThrow(
      HandlerError
    );
  } finally {
    store.close();
  }
});

test('spawnSessionMember directly invites a Monad Agent without adding a project template', async () => {
  const store = createStore();
  try {
    const project = fixtureProject(store);
    const session = fixtureSession(store, { projectId: project.id });
    const agentId = 'agt_000000000000' as AgentId;
    const { handlers } = buildHarness(store, [], [{ id: agentId, name: 'Reviewer' }]);

    const { member } = await handlers.spawnSessionMember({
      sessionId: session.id,
      type: 'mesh-agent',
      name: `monad--${agentId}`
    });

    expect(member.profileId).toBe(`monad--${agentId}`);
    expect(member.displayName).toBe(`monad--${agentId}`);
    expect(store.getWorkplaceProject(project.id)?.memberTemplates).toEqual([]);
  } finally {
    store.close();
  }
});

test('spawnSessionMember persists an ad hoc profile without starting an unavailable runtime', async () => {
  const store = createStore();
  try {
    const project = fixtureProject(store);
    const session = fixtureSession(store, { projectId: project.id });
    const { handlers } = buildHarness(store, [
      {
        name: 'claude-code',
        displayName: 'Claude Code',
        provider: 'claude-code',
        command: 'claude',
        enabled: true,
        allowAutopilot: true,
        approvalOwnership: 'provider-owned'
      }
    ]);

    const { member, binding } = await handlers.spawnSessionMember({
      sessionId: session.id,
      type: 'mesh-agent',
      name: 'missing-agent'
    });
    expect({
      binding: binding.lifecycle,
      displayName: member.displayName,
      memberCount: store.listSessionMembers(session.id).length,
      profileId: member.profileId
    }).toEqual({
      binding: 'active',
      displayName: 'missing-agent',
      memberCount: 1,
      profileId: 'missing-agent'
    });
  } finally {
    store.close();
  }
});

test('inviteSessionMember rejects a session with no project', async () => {
  const store = createStore();
  try {
    const session = fixtureSession(store);
    const { handlers } = buildHarness(store);

    await expect(handlers.inviteSessionMember({ sessionId: session.id, templateId: 'tmpl_codex' })).rejects.toThrow(
      HandlerError
    );
  } finally {
    store.close();
  }
});

test('inviteSessionMember is idempotent when roster reconciliation already added the template', async () => {
  const store = createStore();
  try {
    const project = fixtureProject(store, { memberTemplates: [codexTemplate] });
    const session = fixtureSession(store, { projectId: project.id });
    const { handlers } = buildHarness(store);

    const first = await handlers.inviteSessionMember({ sessionId: session.id, templateId: codexTemplate.id });
    const second = await handlers.inviteSessionMember({ sessionId: session.id, templateId: codexTemplate.id });

    expect(second).toEqual(first);
    expect(store.listSessionMembers(session.id)).toHaveLength(1);
  } finally {
    store.close();
  }
});

test('inviting the same template into two different sessions produces two distinct members', async () => {
  const store = createStore();
  try {
    const project = fixtureProject(store, { memberTemplates: [codexTemplate] });
    const sessionA = fixtureSession(store, { projectId: project.id });
    const sessionB = fixtureSession(store, { projectId: project.id });
    const { handlers } = buildHarness(store);

    const a = (await handlers.inviteSessionMember({ sessionId: sessionA.id, templateId: codexTemplate.id })).member;
    const b = (await handlers.inviteSessionMember({ sessionId: sessionB.id, templateId: codexTemplate.id })).member;

    // One Profile (template) instantiated into two sessions yields two distinct ProjectMember
    // identities, each with its own session-scoped binding — not a shared member.
    expect(a.id).not.toBe(b.id);
    expect({
      aProfile: store.getProjectMember(project.id, a.id)?.profileId,
      bProfile: store.getProjectMember(project.id, b.id)?.profileId,
      aBinding: store.getSessionBinding(sessionA.id, a.id)?.sessionId,
      bBinding: store.getSessionBinding(sessionB.id, b.id)?.sessionId
    }).toEqual({
      aProfile: codexTemplate.id,
      bProfile: codexTemplate.id,
      aBinding: sessionA.id,
      bBinding: sessionB.id
    });
  } finally {
    store.close();
  }
});

test('spawnSessionMember creates an ad-hoc member with no templateId and never touches memberTemplates', async () => {
  const store = createStore();
  try {
    const project = fixtureProject(store);
    const session = fixtureSession(store, { projectId: project.id });
    const { handlers } = buildHarness(store, [
      {
        name: 'claude-code',
        displayName: 'Claude Code',
        provider: 'claude-code',
        command: 'claude',
        enabled: true,
        allowAutopilot: true,
        approvalOwnership: 'provider-owned'
      }
    ]);

    const { member, binding } = await handlers.spawnSessionMember({
      sessionId: session.id,
      type: 'mesh-agent',
      name: 'claude-code',
      displayName: 'Ad hoc Claude'
    });

    // Ad-hoc spawn: no template Profile ref, so profileId is the raw agent name; the legacy row keeps a
    // null templateId and the project's memberTemplates are never touched. An active binding is minted.
    expect(member.profileId).toBe('claude-code');
    expect(member.displayName).toBe('Ad hoc Claude');
    expect(binding.lifecycle).toBe('active');
    expect(store.getSessionMember(session.id, member.id)?.templateId).toBe(null);
    expect(store.getWorkplaceProject(project.id)?.memberTemplates).toEqual([]);
  } finally {
    store.close();
  }
});

test('removeSessionMember stops the runtime when bound and deletes the row', async () => {
  const store = createStore();
  try {
    const project = fixtureProject(store, { memberTemplates: [codexTemplate] });
    const session = fixtureSession(store, { projectId: project.id });
    const { handlers, stopCalls } = buildHarness(store);

    const memberId = (await handlers.inviteSessionMember({ sessionId: session.id, templateId: codexTemplate.id }))
      .member.id;
    store.updateSessionMember(session.id, memberId, {
      meshSessionId: 'mesh_running00000',
      updatedAt: new Date().toISOString()
    });
    const legacyMessageId = newId('msg');
    const snapshottedMessageId = newId('msg');
    store.insertMessage(legacyMessageId, session.id, 'legacy', new Date().toISOString(), 'assistant', {
      data: { agentName: memberId, source: 'managed-mesh-agent' }
    });
    store.insertMessage(snapshottedMessageId, session.id, 'snapshot', new Date().toISOString(), 'assistant', {
      data: {
        agentName: memberId,
        agentDisplayName: 'Original Codex',
        source: 'managed-mesh-agent'
      }
    });

    const result = await handlers.removeSessionMember({ sessionId: session.id, memberId });

    expect(result).toEqual({ deleted: true });
    expect(stopCalls).toEqual(['mesh_running00000']);
    expect(store.listSessionMembers(session.id)).toEqual([]);
    expect(store.getMessage(session.id, legacyMessageId)?.data).toEqual({
      agentName: memberId,
      agentDisplayName: 'Codex',
      source: 'managed-mesh-agent'
    });
    expect(store.getMessage(session.id, snapshottedMessageId)?.data).toEqual({
      agentName: memberId,
      agentDisplayName: 'Original Codex',
      source: 'managed-mesh-agent'
    });
  } finally {
    store.close();
  }
});

test('removeSessionMember throws not_found for an unknown member', async () => {
  const store = createStore();
  try {
    const session = fixtureSession(store);
    const { handlers } = buildHarness(store);

    await expect(handlers.removeSessionMember({ sessionId: session.id, memberId: 'nope' })).rejects.toThrow(
      HandlerError
    );
  } finally {
    store.close();
  }
});

const acpOnlyOrigin: OperationSource = {
  surface: 'editor',
  client: 'zed',
  transport: 'acp'
};

test('member CRUD is allowed on an interactive session regardless of origin transport', async () => {
  const store = createStore();
  try {
    const project = fixtureProject(store, { memberTemplates: [codexTemplate] });
    const session = fixtureSession(store, { projectId: project.id, origin: acpOnlyOrigin });
    const { handlers } = buildHarness(store);
    const invited = await handlers.inviteSessionMember({ sessionId: session.id, templateId: codexTemplate.id });
    const spawned = await handlers.spawnSessionMember({ sessionId: session.id, type: 'mesh-agent', name: 'reviewer' });
    const removed = await handlers.removeSessionMember({ sessionId: session.id, memberId: spawned.member.id });

    expect({
      invitedLifecycle: invited.binding.lifecycle,
      remainingActiveBindings: store
        .listSessionBindings(session.id)
        .filter((binding) => binding.lifecycle === 'active')
        .map((binding) => binding.projectMemberId),
      removed
    }).toEqual({
      invitedLifecycle: 'active',
      remainingActiveBindings: [invited.member.id],
      removed: { deleted: true }
    });
  } finally {
    store.close();
  }
});

test('binding a member that has left is a stable conflict that leaves the binding untouched', async () => {
  const store = createStore();
  try {
    const project = fixtureProject(store);
    const session = fixtureSession(store, { projectId: project.id });
    const { handlers } = buildHarness(store);
    const { member } = await handlers.spawnSessionMember({ sessionId: session.id, type: 'mesh-agent', name: 'codex' });

    store.updateSessionBinding(session.id, member.id, { lifecycle: 'left', updatedAt: new Date().toISOString() });
    const leftBinding = store.getSessionBinding(session.id, member.id);

    await expect(handlers.bindSessionMember({ sessionId: session.id, projectMemberId: member.id })).rejects.toThrow(
      'session member has left'
    );
    // The rejected re-bind mutates nothing: cursor, createdAt, lifecycle, and runtime are all preserved.
    expect(store.getSessionBinding(session.id, member.id)).toEqual(leftBinding);
  } finally {
    store.close();
  }
});

test('a runtime stop failure is contained so the durable leave still completes', async () => {
  const store = createStore();
  try {
    const project = fixtureProject(store);
    const session = fixtureSession(store, { projectId: project.id });
    const { handlers } = buildHarness(store, {
      stop: () => {
        throw new Error('MeshAgent session runtime is unavailable');
      }
    });
    const { member } = await handlers.spawnSessionMember({ sessionId: session.id, type: 'mesh-agent', name: 'codex' });
    // Give the member a live runtime pointer so leave attempts (and fails) a stop.
    store.updateSessionMember(session.id, member.id, {
      meshSessionId: 'mesh_leave000001',
      updatedAt: new Date().toISOString()
    });
    const before = store.getSessionBinding(session.id, member.id);
    if (!before) throw new Error('expected an active binding before leave');

    const result = await handlers.removeSessionMember({ sessionId: session.id, memberId: member.id });

    const left = store.getSessionBinding(session.id, member.id);
    if (!left) throw new Error('expected the binding to survive leave');
    expect({ result, left }).toEqual({
      result: { deleted: true },
      left: {
        ...before,
        lifecycle: 'left',
        currentNativeRuntimeSessionId: null,
        updatedAt: left.updatedAt
      }
    });
  } finally {
    store.close();
  }
});

test('listSessionMembers joins each active binding to its ProjectMember identity', async () => {
  const store = createStore();
  try {
    const project = fixtureProject(store, { memberTemplates: [codexTemplate] });
    const session = fixtureSession(store, { projectId: project.id });
    const { handlers } = buildHarness(store);

    await handlers.inviteSessionMember({ sessionId: session.id, templateId: codexTemplate.id });
    await handlers.spawnSessionMember({ sessionId: session.id, type: 'acp', name: 'ad-hoc-acp' });

    const { members } = await handlers.listSessionMembers({ sessionId: session.id });
    // Every entry is the canonical join: a ProjectMember with its own active binding keyed by the same id.
    expect(
      members
        .map((m) => ({
          profileId: m.member.profileId,
          boundToOwnMember: m.binding.projectMemberId === m.member.id,
          lifecycle: m.binding.lifecycle
        }))
        .sort((a, b) => a.profileId.localeCompare(b.profileId))
    ).toEqual([
      { profileId: 'ad-hoc-acp', boundToOwnMember: true, lifecycle: 'active' },
      { profileId: 'tmpl_codex', boundToOwnMember: true, lifecycle: 'active' }
    ]);
  } finally {
    store.close();
  }
});

test('listSessionMembers excludes a member whose binding has left', async () => {
  const store = createStore();
  try {
    const project = fixtureProject(store, { memberTemplates: [codexTemplate] });
    const session = fixtureSession(store, { projectId: project.id });
    const { handlers } = buildHarness(store);

    const invited = await handlers.inviteSessionMember({ sessionId: session.id, templateId: codexTemplate.id });
    await handlers.spawnSessionMember({ sessionId: session.id, type: 'acp', name: 'ad-hoc-acp' });
    await handlers.removeSessionMember({ sessionId: session.id, memberId: invited.member.id });

    const { members } = await handlers.listSessionMembers({ sessionId: session.id });
    // The left member drops out of the active roster; only the still-active spawn remains.
    expect(members.map((m) => m.member.profileId)).toEqual(['ad-hoc-acp']);
    expect(store.getSessionBinding(session.id, invited.member.id)?.lifecycle).toBe('left');
  } finally {
    store.close();
  }
});

test('listSessionMembers fails closed when an active binding has no ProjectMember', async () => {
  const now = new Date().toISOString();
  const session = {
    id: 'ses_corrupted0001' as SessionId,
    projectId: 'prj_corrupted0001'
  } as unknown as Session;
  const orphanBinding = {
    sessionId: session.id,
    projectMemberId: 'pmem_orphaned001',
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    currentNativeRuntimeSessionId: null,
    lifecycle: 'active' as const,
    lastHealth: null,
    createdAt: now,
    updatedAt: now
  };
  // A durable non-left binding whose ProjectMember is missing — a corrupted identity graph.
  const store = {
    getSession: () => session,
    listSessionBindings: () => [orphanBinding],
    getSessionBinding: () => orphanBinding,
    getProjectMember: () => undefined
  } as unknown as ReturnType<typeof createStore>;
  const { handlers } = buildHarness(store);

  let thrown: unknown;
  try {
    await handlers.listSessionMembers({ sessionId: session.id });
  } catch (error) {
    thrown = error;
  }
  // The whole read fails closed rather than returning a partial roster that silently drops the binding.
  expect(thrown).toBeInstanceOf(HandlerError);
  expect((thrown as HandlerError).kind).toBe('internal');
});

test('listSessionMembers allows an HTTP read of a channel-owned Project Session', async () => {
  let bindingsListed = 0;
  let membersFetched = 0;
  const session = {
    id: 'ses_authbefore001' as SessionId,
    projectId: 'prj_authbefore001',
    origin: { surface: 'im', client: 'telegram', transport: 'channel' }
  } as unknown as Session;
  const store = {
    getSession: () => session,
    listSessionBindings: () => {
      bindingsListed += 1;
      return [];
    },
    getProjectMember: () => {
      membersFetched += 1;
      return undefined;
    },
    getSessionBinding: () => undefined
  } as unknown as ReturnType<typeof createStore>;
  const { handlers } = buildHarness(store);

  const result = await handlers.listSessionMembers({ sessionId: session.id });

  expect({ result, bindingsListed, membersFetched }).toEqual({
    result: { members: [] },
    bindingsListed: 1,
    membersFetched: 0
  });
});

test('listProjectRoster returns every project member, including ones never bound into this session', async () => {
  const store = createStore();
  try {
    const project = fixtureProject(store, { memberTemplates: [codexTemplate] });
    const session = fixtureSession(store, { projectId: project.id });
    const { handlers } = buildHarness(store);

    // Bound into this session.
    await handlers.inviteSessionMember({ sessionId: session.id, templateId: codexTemplate.id });
    // A second, unrelated session in the same project — this member is never bound into `session`.
    const otherSession = fixtureSession(store, { projectId: project.id });
    await handlers.inviteSessionMember({ sessionId: otherSession.id, templateId: codexTemplate.id });

    const { members } = await handlers.listProjectRoster({ sessionId: session.id });
    // Both members surface, even though only the first has a binding into `session` at all.
    expect(members.map((m) => m.profileId).sort()).toEqual(['tmpl_codex', 'tmpl_codex']);
    expect(members).toHaveLength(2);
  } finally {
    store.close();
  }
});

test('listProjectRoster includes a disabled member so an already-assigned name still resolves', async () => {
  const store = createStore();
  try {
    const project = fixtureProject(store, { memberTemplates: [codexTemplate] });
    const session = fixtureSession(store, { projectId: project.id });
    const { handlers } = buildHarness(store);

    const invited = await handlers.inviteSessionMember({ sessionId: session.id, templateId: codexTemplate.id });
    await handlers.removeSessionMember({ sessionId: session.id, memberId: invited.member.id });
    store.updateProjectMember(project.id, invited.member.id, {
      updatedAt: new Date().toISOString(),
      lifecycle: 'disabled'
    });

    const { members } = await handlers.listProjectRoster({ sessionId: session.id });
    // Removing the binding (and disabling the member) leaves the durable ProjectMember row intact —
    // the roster still has it, unlike listSessionMembers which excludes it once the binding has left.
    expect(members).toEqual([{ ...invited.member, lifecycle: 'disabled', updatedAt: expect.any(String) }]);
  } finally {
    store.close();
  }
});

test('listProjectRoster returns no members for a session with no project', async () => {
  const store = createStore();
  try {
    const session = fixtureSession(store);
    const { handlers } = buildHarness(store);

    const { members } = await handlers.listProjectRoster({ sessionId: session.id });
    expect(members).toEqual([]);
  } finally {
    store.close();
  }
});

test('listProjectRoster allows an HTTP read of a channel-owned Project Session', async () => {
  let membersListed = 0;
  const session = {
    id: 'ses_rosterauth0001' as SessionId,
    projectId: 'prj_rosterauth0001',
    origin: { surface: 'im', client: 'telegram', transport: 'channel' }
  } as unknown as Session;
  const store = {
    getSession: () => session,
    listProjectMembers: () => {
      membersListed += 1;
      return [];
    }
  } as unknown as ReturnType<typeof createStore>;
  const { handlers } = buildHarness(store);

  const result = await handlers.listProjectRoster({ sessionId: session.id });

  expect({ result, membersListed }).toEqual({ result: { members: [] }, membersListed: 1 });
});
