import type {
  BindSessionMemberRequest,
  InviteSessionMemberRequest,
  SessionId,
  SessionMemberBinding,
  SpawnSessionMemberRequest
} from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';
import type { SessionMemberRosterDeps } from '#/handlers/session/handlers/session-member-roster.ts';
import type { Store } from '#/store/db/index.ts';

import { newId } from '@monad/protocol';

import { HandlerError } from '#/handlers/handler-error.ts';
import { managedMeshAgentProjectMembers } from '#/handlers/session/handlers/messaging-members.ts';
import {
  buildProjectSessionMember,
  createSessionMemberRoster,
  leaveSessionMember
} from '#/handlers/session/handlers/session-member-roster.ts';
import { assertSessionWriteAuthority } from '#/handlers/session/transport-authority.ts';

export type SessionMembersDeps = SessionMemberRosterDeps;

// The canonical joined view of one member: durable ProjectMember identity + this session's binding.
// invite/spawn/bind all resolve through here so every member-producing endpoint returns one shape. An
// active binding always has a ProjectMember (they commit together), so a missing member is a corrupted
// identity graph — fail closed rather than emit a half-formed member.
function requireSessionMemberBinding(
  store: Store,
  projectId: string,
  sessionId: SessionId,
  projectMemberId: string
): SessionMemberBinding {
  const member = store.getProjectMember(projectId, projectMemberId);
  const binding = store.getSessionBinding(sessionId, projectMemberId);
  if (!member || !binding) {
    throw new HandlerError('internal', `session member binding not found: ${projectMemberId}`);
  }
  return { member, binding };
}

/** Session-scoped member CRUD (Track B, decision 4): invite a member from the project's
 *  memberTemplates, spawn one ad hoc, or remove one — the explicit-action counterpart to the
 *  project-level template catalog. Each session's binding is independent: inviting the same
 *  template into two sessions starts two distinct managed-agent runtimes. */
export function createSessionMembersHandlers(ctx: SessionContext, deps: SessionMembersDeps) {
  const {
    deps: { store },
    requireSession
  } = ctx;
  const { addProjectSessionMemberBinding } = createSessionMemberRoster(ctx, deps);

  return {
    async listSessionMembers({ sessionId }: { sessionId: SessionId }) {
      const session = requireSession(sessionId);
      const members: SessionMemberBinding[] = [];
      if (!session.projectId) return { members };
      // The active roster is the session's non-left bindings joined to their ProjectMember identity through
      // the same helper as invite/spawn/bind. A non-left binding must resolve to a ProjectMember (they
      // commit together); a missing one is a corrupted identity graph, so the whole read fails closed
      // rather than silently dropping a durable binding from the roster.
      for (const binding of store.listSessionBindings(sessionId)) {
        if (binding.lifecycle === 'left') continue;
        members.push(requireSessionMemberBinding(store, session.projectId, sessionId, binding.projectMemberId));
      }
      return { members };
    },

    // Every ProjectMember of the session's project, regardless of whether it's currently bound into
    // THIS session. This is the assignee-resolution source: the daemon's own assignment validation
    // (session-plan-mutations.ts) accepts any enabled project member, not just this session's live
    // roster, and a UI must be able to resolve a display name for an already-assigned member who has
    // since left the session or been disabled — so, unlike `listSessionMembers`, nothing is filtered
    // out here.
    async listProjectRoster({ sessionId }: { sessionId: SessionId }) {
      const session = requireSession(sessionId);
      if (!session.projectId) return { members: [] };
      return { members: store.listProjectMembers(session.projectId) };
    },

    async inviteSessionMember({ sessionId, templateId }: { sessionId: SessionId } & InviteSessionMemberRequest) {
      const session = requireSession(sessionId);
      assertSessionWriteAuthority(session);
      if (!session.projectId) throw new HandlerError('invalid', 'session is not bound to a project');
      const project = store.getWorkplaceProject(session.projectId);
      if (!project) throw new HandlerError('not_found', `workplace project not found: ${session.projectId}`);
      const template = project.memberTemplates.find((candidate) => candidate.id === templateId);
      if (!template) throw new HandlerError('not_found', `member template not found: ${templateId}`);
      // Idempotency resolves by the templateId field: a template-backed member carries a fresh
      // per-instance memberId, so a re-invite of the same template into this session returns the
      // existing member rather than minting a second identity.
      const existing = store.getSessionMemberByTemplate(sessionId, templateId);
      if (existing) {
        return requireSessionMemberBinding(store, session.projectId, sessionId, existing.memberId);
      }
      const member = await addProjectSessionMemberBinding(session, template);
      return requireSessionMemberBinding(store, session.projectId, sessionId, member.memberId);
    },

    async bindSessionMember({ sessionId, projectMemberId }: BindSessionMemberRequest) {
      const session = requireSession(sessionId);
      assertSessionWriteAuthority(session);
      if (!session.projectId) throw new HandlerError('invalid', 'session is not bound to a project');
      const member = store.getProjectMember(session.projectId, projectMemberId);
      if (!member) throw new HandlerError('not_found', `project member not found: ${projectMemberId}`);
      const existing = store.getSessionBinding(sessionId, projectMemberId);
      if (existing) {
        // A left binding is a stable conflict — never silently reactivated. Rejoin is a future
        // explicit lifecycle transition; the binding's cursor, createdAt, and runtime stay untouched.
        if (existing.lifecycle === 'left') {
          throw new HandlerError('conflict', `session member has left: ${projectMemberId}`);
        }
        return { member, binding: existing };
      }
      const now = new Date().toISOString();
      store.insertSessionBinding({
        sessionId,
        projectMemberId,
        lastDeliveredSeq: 0,
        lastVisibleSeq: 0,
        lifecycle: 'active',
        createdAt: now,
        updatedAt: now
      });
      const binding = store.getSessionBinding(sessionId, projectMemberId);
      if (!binding) throw new HandlerError('internal', 'bind failed');
      return { member, binding };
    },

    async spawnSessionMember({
      sessionId,
      type,
      name,
      displayName,
      settings
    }: { sessionId: SessionId } & SpawnSessionMemberRequest) {
      const session = requireSession(sessionId);
      assertSessionWriteAuthority(session);
      if (!session.projectId) throw new HandlerError('invalid', 'session is not bound to a project');
      const memberId = newId('pmem');
      const now = new Date().toISOString();
      const { member: canonicalMember, binding } = buildProjectSessionMember({
        projectMemberId: memberId,
        sessionId,
        projectId: session.projectId,
        profileId: name,
        type,
        displayName: displayName ?? name,
        settings,
        now
      });
      // Legacy row + ProjectMember + initial binding commit atomically — no half-built identity graph.
      store.createProjectSessionMember({
        legacyMember: {
          sessionId,
          memberId,
          templateId: null,
          type,
          data: {
            name,
            ...(displayName ? { displayName } : {}),
            ...(settings ? { settings } : {})
          },
          createdAt: now,
          updatedAt: now
        },
        member: canonicalMember,
        binding
      });
      const meshAgents = (ctx.deps.configManager?.get().cfg.meshAgents ?? []).filter(
        (agent) => agent.enabled !== false
      );
      const managed = managedMeshAgentProjectMembers(store, sessionId, meshAgents).find(
        (candidate) => candidate.runtimeAgentName === memberId
      );
      if (ctx.deps.paths && managed) {
        const result = await deps.spawnManagedSessionMember(session, managed);
        if (result.started && result.nativeSessionId) {
          store.updateSessionMember(sessionId, memberId, {
            meshSessionId: result.nativeSessionId,
            updatedAt: new Date().toISOString()
          });
        }
      }
      return requireSessionMemberBinding(store, session.projectId, sessionId, memberId);
    },

    async removeSessionMember({ sessionId, memberId }: { sessionId: SessionId; memberId: string }) {
      assertSessionWriteAuthority(requireSession(sessionId));
      // Canonical-first: leaves a member reachable by its SessionBinding even when it was bound purely
      // through PUT and has no legacy SessionMember row.
      if (!leaveSessionMember(ctx, sessionId, memberId)) {
        throw new HandlerError('not_found', `session member not found: ${memberId}`);
      }
      return { deleted: true as const };
    }
  };
}
