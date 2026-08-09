import type {
  ProjectId,
  ProjectMember,
  ProjectMemberId,
  ProjectMemberLaunchOverrides,
  Session,
  SessionId,
  WorkplaceProject,
  WorkplaceProjectMemberSettings,
  WorkplaceProjectMemberType
} from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';
import type { ManagedMeshAgentProjectMember } from '#/handlers/session/handlers/messaging-members.ts';
import type { SessionBindingInsert } from '#/store/db/session-bindings.ts';
import type { SessionMember } from '#/store/db/session-members.ts';

import { newId } from '@monad/protocol';

import { managedMeshAgentProjectMembers } from '#/handlers/session/handlers/messaging-members.ts';
import { enabledInvitableMeshAgentConfigs } from '#/services/mesh-agent/invitable-agents.ts';

type ProjectMemberTemplate = WorkplaceProject['memberTemplates'][number];
type MemberStore = SessionContext['deps']['store'];

function workingDirectoryOverride(settings?: WorkplaceProjectMemberSettings): string | null {
  return settings?.cwd?.trim() || null;
}

// launchOverrides is the member's settings with cwd/customPrompt explicitly removed — they have their
// own dedicated ProjectMember fields. The omit is done here, not left to a downstream Zod strip, so the
// projection is a property of this code, not a parser side effect.
function toLaunchOverrides(settings?: WorkplaceProjectMemberSettings): ProjectMemberLaunchOverrides {
  if (!settings) return {};
  const { cwd: _cwd, customPrompt: _customPrompt, ...rest } = settings;
  return rest;
}

// Track B identity cutover (strangler-fig): builds the canonical project-scoped ProjectMember plus an
// active per-session SessionBinding (cursor 0) for one member instance. Pure — it does not touch the
// store, so the caller can commit the legacy SessionMember row, the ProjectMember, and the binding in a
// single transaction. The caller owns the id (a fresh id per instance, so the same profile invited or
// spawned twice yields two independent members; the same identity reaches a second session only through
// bindSessionMember). Field projection matches the ruled contract.
export function buildProjectSessionMember(input: {
  projectMemberId: ProjectMemberId;
  sessionId: SessionId;
  projectId: ProjectId;
  profileId: string;
  type: WorkplaceProjectMemberType;
  displayName: string;
  settings?: WorkplaceProjectMemberSettings;
  now: string;
}): { member: ProjectMember; binding: SessionBindingInsert } {
  const { projectMemberId, sessionId, projectId, profileId, type, displayName, settings, now } = input;
  const member: ProjectMember = {
    id: projectMemberId,
    projectId,
    profileId,
    type,
    displayName,
    customPrompt: settings?.customPrompt ?? null,
    launchOverrides: toLaunchOverrides(settings),
    workingDirectoryOverride: workingDirectoryOverride(settings),
    lifecycle: 'enabled',
    createdAt: now,
    updatedAt: now
  };
  const binding: SessionBindingInsert = {
    sessionId,
    projectMemberId,
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    lifecycle: 'active',
    createdAt: now,
    updatedAt: now
  };
  return { member, binding };
}

export interface SessionMemberRosterDeps {
  spawnManagedSessionMember: (
    session: Session,
    member: ManagedMeshAgentProjectMember
  ) => Promise<{ started: boolean; nativeSessionId?: string }>;
}

function templateData(template: ProjectMemberTemplate): Record<string, unknown> {
  return {
    name: template.name,
    ...(template.displayName ? { displayName: template.displayName } : {}),
    ...(template.settings ? { settings: template.settings } : {})
  };
}

// The canonical ProjectMember fields a template projects onto when it joins a session. Excludes
// identity (id/profileId) and lifecycle/createdAt, which are owned by the member, not the template.
interface TemplateMemberProjection {
  type: WorkplaceProjectMemberType;
  displayName: string;
  customPrompt: string | null;
  workingDirectoryOverride: string | null;
  launchOverrides: ProjectMemberLaunchOverrides;
}
function templateMemberProjection(template: ProjectMemberTemplate): TemplateMemberProjection {
  return {
    type: template.type,
    displayName: template.displayName ?? template.name,
    customPrompt: template.settings?.customPrompt ?? null,
    workingDirectoryOverride: workingDirectoryOverride(template.settings),
    launchOverrides: toLaunchOverrides(template.settings)
  };
}

// Atomically mints a fresh template-backed member instance: a new per-instance memberId (so the same
// template invited into two Sessions is two distinct ProjectMembers), the templateId kept as the
// Profile reference, profileId = template.id. Legacy row + ProjectMember + binding commit together. No
// idempotency check and no runtime launch here — the caller owns both.
export function mintTemplateSessionMember(
  store: MemberStore,
  session: Session,
  template: ProjectMemberTemplate,
  now: string
): SessionMember {
  if (!session.projectId) throw new Error(`template-backed member requires a project session: ${session.id}`);
  const memberId = newId('pmem');
  const member: ProjectMember = {
    id: memberId,
    projectId: session.projectId,
    profileId: template.id,
    ...templateMemberProjection(template),
    lifecycle: 'enabled',
    createdAt: now,
    updatedAt: now
  };
  const binding: SessionBindingInsert = {
    sessionId: session.id,
    projectMemberId: memberId,
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    lifecycle: 'active',
    createdAt: now,
    updatedAt: now
  };
  store.createProjectSessionMember({
    legacyMember: {
      sessionId: session.id,
      memberId,
      templateId: template.id,
      type: template.type,
      data: templateData(template),
      createdAt: now,
      updatedAt: now
    },
    member,
    binding
  });
  const created = store.getSessionMember(session.id, memberId);
  if (!created) throw new Error(`session member insert failed: ${memberId}`);
  return created;
}

// Canonical-first leave: resolves the member by its SessionBinding OR its legacy SessionMember row, so
// a binding created purely through bindSessionMember (no legacy row) can still be left. Order is: stop
// the current runtime (best-effort, outside any transaction) → atomically leave the binding (lifecycle
// 'left' + runtime cleared) → optionally drop the legacy row. Leaving the binding before deleting the
// legacy row means a crash can never leave a legacy-deleted-but-binding-active state. Returns false when
// neither a binding nor a legacy row exists (not found).
export function leaveSessionMember(ctx: SessionContext, sessionId: SessionId, memberId: string): boolean {
  const {
    deps: { store, meshAgentHost, log }
  } = ctx;
  const binding = store.getSessionBinding(sessionId, memberId);
  const legacyMember = store.getSessionMember(sessionId, memberId);
  if (!binding && !legacyMember) return false;

  // Stopping the runtime is best-effort and must never block the durable leave: MeshAgentHost.stop
  // throws when a live entry has no session runtime, but the binding still has to reach 'left'.
  const runtimeId = binding?.currentNativeRuntimeSessionId ?? legacyMember?.meshSessionId ?? null;
  if (runtimeId) {
    try {
      meshAgentHost?.stop(runtimeId);
    } catch (error) {
      log?.warn({ sessionId, memberId, meshSessionId: runtimeId, err: error }, 'mesh runtime stop failed on leave');
    }
  }

  if (binding) store.leaveSessionBinding(sessionId, memberId, new Date().toISOString());

  if (legacyMember) {
    const data = legacyMember.data as { name?: string; displayName?: string };
    const displayName = data.displayName ?? data.name ?? memberId;
    store.snapshotAgentDisplayName(sessionId, memberId, displayName);
    if (legacyMember.templateId && legacyMember.templateId !== memberId) {
      store.snapshotAgentDisplayName(sessionId, legacyMember.templateId, displayName);
    }
    store.deleteSessionMember(sessionId, memberId);
  }
  return true;
}

export function createSessionMemberRoster(ctx: SessionContext, deps: SessionMemberRosterDeps) {
  const {
    deps: { store, paths, log }
  } = ctx;

  async function spawnIfManaged(session: Session, memberId: string): Promise<void> {
    if (!paths) return;
    const cfg = ctx.deps.configManager?.get().cfg;
    const meshAgents = cfg ? enabledInvitableMeshAgentConfigs(cfg) : [];
    const managed = managedMeshAgentProjectMembers(store, session.id, meshAgents).find(
      (candidate) => candidate.runtimeAgentName === memberId
    );
    if (!managed) return;
    const result = await deps.spawnManagedSessionMember(session, managed);
    if (result.started && result.nativeSessionId) {
      store.updateSessionMember(session.id, memberId, {
        meshSessionId: result.nativeSessionId,
        updatedAt: new Date().toISOString()
      });
    }
  }

  async function addProjectSessionMemberBinding(
    session: Session,
    template: ProjectMemberTemplate
  ): Promise<SessionMember> {
    // Same-session idempotency: a member already invited from this template is returned as-is.
    const existing = store.getSessionMemberByTemplate(session.id, template.id);
    if (existing) return existing;
    const minted = mintTemplateSessionMember(store, session, template, new Date().toISOString());
    // The durable member + binding is the invite completion boundary. Runtime preflight/start can take
    // seconds and must not hold the HTTP response or make the Settings action appear inert.
    void spawnIfManaged(session, minted.memberId).catch((error) => {
      log?.warn(
        { sessionId: session.id, memberId: minted.memberId, err: error },
        'managed session member background start failed'
      );
    });
    return minted;
  }

  return { addProjectSessionMemberBinding };
}
