import type { MeshAgentConfig } from '@monad/environment';
import type { Session, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  AMBIGUOUS_MEMBER_TARGET_CODE,
  AmbiguousMemberTargetError,
  canonicalDirectMembers,
  managedMeshAgentProjectMembers,
  resolveDirectMessageTarget,
  resolveManagedMember
} from '#/handlers/session/handlers/messaging-members.ts';
import { createStore } from '#/store/db/index.ts';

const DIRECT_TARGET_PROJECT = 'prj_dirtarget001';

// A project session with a canonical roster and NO legacy session_members rows: the members exist purely as
// ProjectMember + SessionBinding, exactly the shape bindSessionMember produces. The resolver must find them.
function boundSession(store: ReturnType<typeof createStore>, id: SessionId): void {
  const now = new Date().toISOString();
  store.insertWorkplaceProject({
    id: DIRECT_TARGET_PROJECT,
    title: 'Direct targets',
    state: 'active',
    archived: false,
    memberTemplates: [],
    createdAt: now,
    updatedAt: now
  });
  store.insertSession({
    id,
    projectId: DIRECT_TARGET_PROJECT,
    title: 'Workplace: Test',
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    cwd: process.cwd(),
    createdAt: now,
    updatedAt: now
  } satisfies Session);
}

function boundMember(
  store: ReturnType<typeof createStore>,
  sessionId: SessionId,
  memberId: string,
  opts: {
    profileId: string;
    displayName: string;
    lifecycle?: 'active' | 'left';
    workingDirectoryOverride?: string;
  }
): void {
  const now = new Date().toISOString();
  store.insertProjectMember({
    id: memberId,
    projectId: DIRECT_TARGET_PROJECT,
    profileId: opts.profileId,
    type: 'mesh-agent',
    displayName: opts.displayName,
    customPrompt: null,
    launchOverrides: {},
    workingDirectoryOverride: opts.workingDirectoryOverride ?? null,
    lifecycle: 'enabled',
    createdAt: now,
    updatedAt: now
  });
  store.insertSessionBinding({
    sessionId,
    projectMemberId: memberId,
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    lifecycle: opts.lifecycle ?? 'active',
    createdAt: now,
    updatedAt: now
  });
}

const candidate = (
  projectMemberId: string,
  runtimeAgentName: string,
  templateAgentName: string,
  // Default the displayName to the (unique) projectMemberId so a candidate never collides on displayName
  // unless a test sets it explicitly.
  displayName: string = projectMemberId
) => ({
  projectMemberId,
  runtimeAgentName,
  templateAgentName,
  displayName
});

const codex = {
  name: 'codex',
  provider: 'codex',
  command: 'codex',
  enabled: true,
  allowAutopilot: false,
  approvalOwnership: 'provider-owned'
} satisfies MeshAgentConfig;

const claudeReviewer = {
  name: 'claude-code',
  provider: 'claude-code',
  command: 'claude',
  enabled: true,
  allowAutopilot: false,
  approvalOwnership: 'provider-owned'
} satisfies MeshAgentConfig;

const monadAgent = {
  name: 'monad--agt_eAmWnO0FDkBJ',
  displayName: 'Reviewer',
  provider: 'monad',
  command: 'monad',
  enabled: true,
  allowAutopilot: true,
  approvalOwnership: 'provider-owned',
  adapterSettings: { agentId: 'agt_eAmWnO0FDkBJ' }
} satisfies MeshAgentConfig;

test('managed project members keep resolved and configured display names distinct', () => {
  const store = createStore();
  const now = new Date().toISOString();
  const session = {
    id: 'ses_membernames001' as SessionId,
    title: 'Workplace: Test',
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
    cwd: process.cwd(),
    createdAt: now,
    updatedAt: now
  } satisfies Session;
  store.insertSession(session);
  store.insertSessionMember({
    sessionId: session.id,
    memberId: 'pmem_codex_default',
    templateId: 'pmem_codex_template',
    type: 'mesh-agent',
    data: {
      name: 'codex',
      instanceId: 'pmem_codex_default',
      settings: { managedProjectAgent: true }
    },
    createdAt: now,
    updatedAt: now
  });
  store.insertSessionMember({
    sessionId: session.id,
    memberId: 'pmem_codex_reviewer',
    templateId: 'pmem_codex_template',
    type: 'mesh-agent',
    data: {
      name: 'codex',
      displayName: 'Reviewer',
      instanceId: 'pmem_codex_reviewer',
      settings: { managedProjectAgent: true, cwd: '/tmp/reviewer' }
    },
    createdAt: now,
    updatedAt: now
  });

  try {
    expect(managedMeshAgentProjectMembers(store, session.id, [codex])).toEqual([
      {
        spec: codex,
        projectMemberId: 'pmem_codex_default',
        runtimeAgentName: 'pmem_codex_default',
        templateAgentName: 'codex',
        displayName: 'codex',
        configuredDisplayName: undefined,
        settings: { managedProjectAgent: true }
      },
      {
        spec: codex,
        projectMemberId: 'pmem_codex_reviewer',
        runtimeAgentName: 'pmem_codex_reviewer',
        templateAgentName: 'codex',
        displayName: 'Reviewer',
        configuredDisplayName: 'Reviewer',
        settings: { managedProjectAgent: true, cwd: '/tmp/reviewer' }
      }
    ]);
  } finally {
    store.close();
  }
});

test('managed Monad members use the discovered agent name when no project alias is configured', () => {
  const store = createStore();
  const now = new Date().toISOString();
  const session = {
    id: 'ses_monadnames0001' as SessionId,
    title: 'Workplace: Test',
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
    cwd: process.cwd(),
    createdAt: now,
    updatedAt: now
  } satisfies Session;
  store.insertSession(session);
  store.insertSessionMember({
    sessionId: session.id,
    memberId: 'monad:agt_eAmWnO0FDkBJ',
    templateId: 'monad:agt_eAmWnO0FDkBJ',
    type: 'mesh-agent',
    data: {
      name: 'monad--agt_eAmWnO0FDkBJ',
      settings: { managedProjectAgent: true }
    },
    createdAt: now,
    updatedAt: now
  });

  try {
    expect(managedMeshAgentProjectMembers(store, session.id, [monadAgent])).toEqual([
      {
        spec: monadAgent,
        projectMemberId: 'monad:agt_eAmWnO0FDkBJ',
        runtimeAgentName: 'monad:agt_eAmWnO0FDkBJ',
        templateAgentName: 'monad--agt_eAmWnO0FDkBJ',
        displayName: 'Reviewer',
        configuredDisplayName: undefined,
        settings: { managedProjectAgent: true }
      }
    ]);
  } finally {
    store.close();
  }
});

test('resolveManagedMember matches an exact projectMemberId even when an alias collides', () => {
  const members = [
    candidate('pmem_codex_default', 'pmem_codex_default', 'codex'),
    candidate('pmem_codex_reviewer', 'pmem_codex_reviewer', 'codex')
  ];
  expect(resolveManagedMember(members, 'pmem_codex_reviewer')).toEqual(
    candidate('pmem_codex_reviewer', 'pmem_codex_reviewer', 'codex')
  );
});

test('resolveManagedMember resolves a unique runtimeAgentName alias', () => {
  const members = [
    candidate('pmem_codex_default', 'runtime_codex_1', 'codex'),
    candidate('pmem_claude_default', 'runtime_claude_1', 'claude-code')
  ];
  expect(resolveManagedMember(members, 'runtime_claude_1')).toEqual(
    candidate('pmem_claude_default', 'runtime_claude_1', 'claude-code')
  );
});

test('resolveManagedMember resolves a unique displayName alias', () => {
  const members = [
    candidate('pmem_codex_default', 'runtime_codex_1', 'codex', 'Codex'),
    candidate('pmem_claude_default', 'runtime_claude_1', 'claude-code', 'Reviewer')
  ];
  expect(resolveManagedMember(members, 'Reviewer')).toEqual(
    candidate('pmem_claude_default', 'runtime_claude_1', 'claude-code', 'Reviewer')
  );
});

test('resolveManagedMember throws AmbiguousMemberTargetError when a displayName is shared by several members', () => {
  const members = [
    candidate('pmem_codex_default', 'runtime_codex_1', 'codex', 'Reviewer'),
    candidate('pmem_claude_default', 'runtime_claude_1', 'claude-code', 'Reviewer')
  ];
  let thrown: unknown;
  try {
    resolveManagedMember(members, 'Reviewer');
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(AmbiguousMemberTargetError);
  expect((thrown as AmbiguousMemberTargetError).code).toBe(AMBIGUOUS_MEMBER_TARGET_CODE);
  expect((thrown as AmbiguousMemberTargetError).matchedMemberIds).toEqual([
    'pmem_claude_default',
    'pmem_codex_default'
  ]);
});

test('resolveManagedMember throws AmbiguousMemberTargetError when a template alias matches several members', () => {
  const members = [
    candidate('pmem_codex_default', 'pmem_codex_default', 'codex'),
    candidate('pmem_codex_reviewer', 'pmem_codex_reviewer', 'codex')
  ];
  let thrown: unknown;
  try {
    resolveManagedMember(members, 'codex');
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(AmbiguousMemberTargetError);
  expect((thrown as AmbiguousMemberTargetError).code).toBe(AMBIGUOUS_MEMBER_TARGET_CODE);
  expect((thrown as AmbiguousMemberTargetError).requestedId).toBe('codex');
  expect((thrown as AmbiguousMemberTargetError).matchedMemberIds).toEqual([
    'pmem_codex_default',
    'pmem_codex_reviewer'
  ]);
});

test('resolveManagedMember returns undefined when nothing matches', () => {
  const members = [candidate('pmem_codex_default', 'pmem_codex_default', 'codex')];
  // presence-ok: a not-found target must resolve to undefined (caller treats it as "not found", not a conflict)
  expect(resolveManagedMember(members, 'pmem_missing')).toBeUndefined();
});

test('resolveDirectMessageTarget classifies an exact projectMemberId of a canonical binding-only member', () => {
  const store = createStore();
  const sessionId = 'ses_dmtarget0001' as SessionId;
  try {
    boundSession(store, sessionId);
    // No session_members row — the member exists only as ProjectMember + active SessionBinding.
    boundMember(store, sessionId, 'pmem_codex_default', { profileId: 'codex', displayName: 'Lily' });
    expect(resolveDirectMessageTarget(store, sessionId, [], 'pmem_codex_default')).toEqual({
      kind: 'project_member',
      projectMemberId: 'pmem_codex_default'
    });
  } finally {
    store.close();
  }
});

test('resolveDirectMessageTarget classifies a unique alias of a canonical binding-only member', () => {
  const store = createStore();
  const sessionId = 'ses_dmtarget0002' as SessionId;
  try {
    boundSession(store, sessionId);
    boundMember(store, sessionId, 'pmem_codex_default', { profileId: 'codex', displayName: 'Lily' });
    // Addressed by the member's display-name alias — resolves to its canonical pmid with no legacy row.
    expect(resolveDirectMessageTarget(store, sessionId, [], 'Lily')).toEqual({
      kind: 'project_member',
      projectMemberId: 'pmem_codex_default'
    });
  } finally {
    store.close();
  }
});

test('resolveDirectMessageTarget throws AMBIGUOUS_MEMBER_TARGET when two canonical bindings share an alias', () => {
  const store = createStore();
  const sessionId = 'ses_dmtarget0003' as SessionId;
  try {
    boundSession(store, sessionId);
    // Two canonical members backed by the same profile 'codex' — the template alias is ambiguous.
    boundMember(store, sessionId, 'pmem_codex_a', { profileId: 'codex', displayName: 'Rev A' });
    boundMember(store, sessionId, 'pmem_codex_b', { profileId: 'codex', displayName: 'Rev B' });
    let thrown: unknown;
    try {
      resolveDirectMessageTarget(store, sessionId, [], 'codex');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AmbiguousMemberTargetError);
    expect((thrown as AmbiguousMemberTargetError).code).toBe(AMBIGUOUS_MEMBER_TARGET_CODE);
    expect((thrown as AmbiguousMemberTargetError).matchedMemberIds).toEqual(['pmem_codex_a', 'pmem_codex_b']);
  } finally {
    store.close();
  }
});

test('resolveDirectMessageTarget excludes a left canonical member, classifying its id as a private label', () => {
  const store = createStore();
  const sessionId = 'ses_dmtarget0005' as SessionId;
  try {
    boundSession(store, sessionId);
    boundMember(store, sessionId, 'pmem_codex_left', { profileId: 'codex', displayName: 'Gone', lifecycle: 'left' });
    // A left binding suppresses the member — its own pmid no longer resolves and is kept as a raw label.
    expect(resolveDirectMessageTarget(store, sessionId, [], 'pmem_codex_left')).toEqual({
      kind: 'private_label',
      label: 'pmem_codex_left'
    });
  } finally {
    store.close();
  }
});

test('resolveDirectMessageTarget ignores a legacy session_members row with no canonical binding', () => {
  const store = createStore();
  const sessionId = 'ses_dmtarget0006' as SessionId;
  try {
    boundSession(store, sessionId);
    // A legacy session_members row with NO SessionBinding — after the Track B cutover this is graph
    // corruption, never a deliverable member. Neither its id nor its alias resolves.
    const now = new Date().toISOString();
    store.insertSessionMember({
      sessionId,
      memberId: 'pmem_ghost000001',
      templateId: null,
      type: 'mesh-agent',
      data: { name: 'codex', instanceId: 'ghost', settings: { managedProjectAgent: true } },
      createdAt: now,
      updatedAt: now
    });
    expect(resolveDirectMessageTarget(store, sessionId, [codex], 'pmem_ghost000001')).toEqual({
      kind: 'private_label',
      label: 'pmem_ghost000001'
    });
    expect(resolveDirectMessageTarget(store, sessionId, [codex], 'ghost')).toEqual({
      kind: 'private_label',
      label: 'ghost'
    });
  } finally {
    store.close();
  }
});

test('resolveDirectMessageTarget resolves a canonical member by its provider spec name', () => {
  const store = createStore();
  const sessionId = 'ses_dmtarget0008' as SessionId;
  try {
    boundSession(store, sessionId);
    boundMember(store, sessionId, 'pmem_claude_rev1', { profileId: 'claude-code', displayName: 'Reviewer' });
    expect(resolveDirectMessageTarget(store, sessionId, [claudeReviewer], 'claude-code')).toEqual({
      kind: 'project_member',
      projectMemberId: 'pmem_claude_rev1'
    });
    // Exact pmid and the display-name alias resolve to the same member.
    expect(resolveDirectMessageTarget(store, sessionId, [claudeReviewer], 'pmem_claude_rev1')).toEqual({
      kind: 'project_member',
      projectMemberId: 'pmem_claude_rev1'
    });
    expect(resolveDirectMessageTarget(store, sessionId, [claudeReviewer], 'Reviewer')).toEqual({
      kind: 'project_member',
      projectMemberId: 'pmem_claude_rev1'
    });
  } finally {
    store.close();
  }
});

test('canonicalDirectMembers classifies a spec-backed member as a startable available member', () => {
  const store = createStore();
  const sessionId = 'ses_dmtarget0009' as SessionId;
  try {
    boundSession(store, sessionId);
    boundMember(store, sessionId, 'pmem_claude_rev1', {
      profileId: 'claude-code',
      displayName: 'Reviewer',
      workingDirectoryOverride: '/tmp/reviewer'
    });
    boundMember(store, sessionId, 'pmem_noconfig001', { profileId: 'unconfigured', displayName: 'Nobody' });

    const { available, unavailable } = canonicalDirectMembers(store, sessionId, [claudeReviewer]);
    expect(
      available.map((member) => ({
        pmid: member.projectMemberId,
        template: member.templateAgentName,
        spec: member.spec.name,
        runtime: member.runtimeAgentName,
        cwd: member.settings.cwd
      }))
    ).toEqual([
      {
        pmid: 'pmem_claude_rev1',
        template: 'claude-code',
        spec: 'claude-code',
        runtime: 'pmem_claude_rev1',
        cwd: '/tmp/reviewer'
      }
    ]);
    // The spec-less member is UNAVAILABLE (connection-required), never silently dropped.
    expect(unavailable.map((member) => ({ pmid: member.projectMemberId, code: member.code }))).toEqual([
      { pmid: 'pmem_noconfig001', code: 'provider_unavailable' }
    ]);
  } finally {
    store.close();
  }
});

test('resolveDirectMessageTarget keeps a non-member addressing string as a verbatim private label', () => {
  const store = createStore();
  const sessionId = 'ses_dmtarget0004' as SessionId;
  try {
    boundSession(store, sessionId);
    boundMember(store, sessionId, 'pmem_codex_default', { profileId: 'codex', displayName: 'Lily' });
    // 'human:zeke' matches no member — it is the agent's private ledger label, returned untouched.
    expect(resolveDirectMessageTarget(store, sessionId, [], 'human:zeke')).toEqual({
      kind: 'private_label',
      label: 'human:zeke'
    });
  } finally {
    store.close();
  }
});

test('managed project members resolve mesh config from template id instead of member name', () => {
  const store = createStore();
  const now = new Date().toISOString();
  const session = {
    id: 'ses_membertemplate01' as SessionId,
    title: 'Workplace: Test',
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
    cwd: process.cwd(),
    createdAt: now,
    updatedAt: now
  } satisfies Session;
  const claude = {
    name: 'claude-code',
    provider: 'claude-code',
    command: 'claude',
    enabled: true,
    allowAutopilot: true,
    approvalOwnership: 'provider-owned'
  } satisfies MeshAgentConfig;
  store.insertSession(session);
  store.insertSessionMember({
    sessionId: session.id,
    memberId: 'pmem_claude_reviewer',
    templateId: 'tpl_claude_reviewer',
    type: 'mesh-agent',
    data: {
      name: 'claude-code',
      displayName: 'Reviewer',
      instanceId: 'pmem_claude_reviewer',
      settings: { managedProjectAgent: true }
    },
    createdAt: now,
    updatedAt: now
  });

  try {
    expect(managedMeshAgentProjectMembers(store, session.id, [claude])).toEqual([
      {
        spec: claude,
        projectMemberId: 'pmem_claude_reviewer',
        runtimeAgentName: 'pmem_claude_reviewer',
        templateAgentName: 'claude-code',
        displayName: 'Reviewer',
        configuredDisplayName: 'Reviewer',
        settings: { managedProjectAgent: true }
      }
    ]);
  } finally {
    store.close();
  }
});
