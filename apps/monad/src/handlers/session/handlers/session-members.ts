import type {
  InviteSessionMemberRequest,
  Session,
  SessionId,
  SpawnSessionMemberRequest,
  WorkplaceProjectSessionMember
} from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';
import type { SessionMemberRosterDeps } from '#/handlers/session/handlers/session-member-roster.ts';
import type { SessionMember } from '#/store/db/session-members.ts';

import { newId } from '@monad/protocol';

import { HandlerError } from '#/handlers/handler-error.ts';
import { managedExternalAgentProjectMembers } from '#/handlers/session/handlers/messaging-members.ts';
import {
  createSessionMemberRoster,
  removeSessionMemberBinding
} from '#/handlers/session/handlers/session-member-roster.ts';

export type SessionMembersDeps = SessionMemberRosterDeps;

// Access control reads the write policy STORED on the session (origin.writableBy) — mirrors the
// check in messaging.ts / forward-acp.ts / forward-external-agent.ts (kept local so this module
// has no import-cycle back to them). Without this, a session whose policy says only 'acp' or
// 'channel' may write (e.g. an editor- or IM-bound session) could still have its member roster
// mutated — and managed-agent runtimes started/stopped — over plain HTTP.
function assertWriteAllowed(session: Session, transport: 'http'): void {
  const writableBy = session.origin?.writableBy;
  if (!writableBy) return;
  if (!writableBy.includes(transport)) {
    throw new HandlerError('forbidden', `transport '${transport}' cannot write to this session`);
  }
}

function toWireMember(row: SessionMember): WorkplaceProjectSessionMember {
  const data = row.data as {
    name?: string;
    displayName?: string;
    settings?: WorkplaceProjectSessionMember['settings'];
  };
  return {
    id: row.memberId,
    ...(row.templateId ? { templateId: row.templateId } : {}),
    type: row.type as WorkplaceProjectSessionMember['type'],
    name: data.name ?? row.memberId,
    ...(data.displayName ? { displayName: data.displayName } : {}),
    ...(data.settings ? { settings: data.settings } : {}),
    ...(row.externalAgentSessionId
      ? {
          externalAgentSessionId: row.externalAgentSessionId as WorkplaceProjectSessionMember['externalAgentSessionId']
        }
      : {})
  };
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
      requireSession(sessionId);
      return { members: store.listSessionMembers(sessionId).map(toWireMember) };
    },

    async inviteSessionMember({ sessionId, templateId }: { sessionId: SessionId } & InviteSessionMemberRequest) {
      const session = requireSession(sessionId);
      assertWriteAllowed(session, 'http');
      if (!session.projectId) throw new HandlerError('invalid', 'session is not bound to a project');
      const project = store.getWorkplaceProject(session.projectId);
      if (!project) throw new HandlerError('not_found', `workplace project not found: ${session.projectId}`);
      const template = project.memberTemplates.find((candidate) => candidate.id === templateId);
      if (!template) throw new HandlerError('not_found', `member template not found: ${templateId}`);
      if (store.getSessionMember(sessionId, templateId)) {
        throw new HandlerError('invalid', `member already invited into this session: ${templateId}`);
      }
      const member = await addProjectSessionMemberBinding(session, template);
      return { member: toWireMember(member) };
    },

    async spawnSessionMember({
      sessionId,
      type,
      name,
      displayName,
      settings
    }: { sessionId: SessionId } & SpawnSessionMemberRequest) {
      const session = requireSession(sessionId);
      assertWriteAllowed(session, 'http');
      const memberId = newId('pmem');
      const now = new Date().toISOString();
      store.insertSessionMember({
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
      });
      const externalAgents = (ctx.deps.configManager?.get().cfg.externalAgents ?? []).filter(
        (agent) => agent.enabled !== false
      );
      const managed = managedExternalAgentProjectMembers(store, sessionId, externalAgents).find(
        (candidate) => candidate.runtimeAgentName === memberId
      );
      if (ctx.deps.paths && managed) {
        const result = await deps.spawnManagedSessionMember(session, managed);
        if (result.started && result.nativeSessionId) {
          store.updateSessionMember(sessionId, memberId, {
            externalAgentSessionId: result.nativeSessionId,
            updatedAt: new Date().toISOString()
          });
        }
      }
      const member = store.getSessionMember(sessionId, memberId);
      if (!member) throw new HandlerError('internal', 'spawn failed');
      return { member: toWireMember(member) };
    },

    async removeSessionMember({ sessionId, memberId }: { sessionId: SessionId; memberId: string }) {
      const session = requireSession(sessionId);
      assertWriteAllowed(session, 'http');
      const member = store.getSessionMember(sessionId, memberId);
      if (!member) throw new HandlerError('not_found', `session member not found: ${memberId}`);
      removeSessionMemberBinding(ctx, member);
      return { deleted: true as const };
    }
  };
}
