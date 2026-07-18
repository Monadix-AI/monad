import type { Session, WorkplaceProject } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';
import type { ManagedExternalAgentProjectMember } from '#/handlers/session/handlers/messaging-members.ts';
import type { SessionMember } from '#/store/db/session-members.ts';

import { managedExternalAgentProjectMembers } from '#/handlers/session/handlers/messaging-members.ts';

type ProjectMemberTemplate = WorkplaceProject['memberTemplates'][number];

export interface SessionMemberRosterDeps {
  spawnManagedSessionMember: (
    session: Session,
    member: ManagedExternalAgentProjectMember
  ) => Promise<{ started: boolean; nativeSessionId?: string }>;
}

function templateData(template: ProjectMemberTemplate): Record<string, unknown> {
  return {
    name: template.name,
    ...(template.displayName ? { displayName: template.displayName } : {}),
    ...(template.settings ? { settings: template.settings } : {})
  };
}

export function removeSessionMemberBinding(ctx: SessionContext, member: SessionMember): void {
  const {
    deps: { store, externalAgentHost }
  } = ctx;
  const data = member.data as { name?: string; displayName?: string };
  const displayName = data.displayName ?? data.name ?? member.memberId;
  store.snapshotAgentDisplayName(member.sessionId, member.memberId, displayName);
  if (member.externalAgentSessionId) externalAgentHost?.stop(member.externalAgentSessionId);
  store.deleteSessionMember(member.sessionId, member.memberId);
}

export function createSessionMemberRoster(ctx: SessionContext, deps: SessionMemberRosterDeps) {
  const {
    deps: { store, paths }
  } = ctx;

  async function spawnIfManaged(session: Session, memberId: string): Promise<void> {
    if (!paths) return;
    const externalAgents = (ctx.deps.configManager?.get().cfg.externalAgents ?? []).filter(
      (agent) => agent.enabled !== false
    );
    const managed = managedExternalAgentProjectMembers(store, session.id, externalAgents).find(
      (candidate) => candidate.runtimeAgentName === memberId
    );
    if (!managed) return;
    const result = await deps.spawnManagedSessionMember(session, managed);
    if (result.started && result.nativeSessionId) {
      store.updateSessionMember(session.id, memberId, {
        externalAgentSessionId: result.nativeSessionId,
        updatedAt: new Date().toISOString()
      });
    }
  }

  async function addProjectSessionMemberBinding(
    session: Session,
    template: ProjectMemberTemplate
  ): Promise<SessionMember> {
    const now = new Date().toISOString();
    store.insertSessionMember({
      sessionId: session.id,
      memberId: template.id,
      templateId: template.id,
      type: template.type,
      data: templateData(template),
      createdAt: now,
      updatedAt: now
    });
    await spawnIfManaged(session, template.id);
    const member = store.getSessionMember(session.id, template.id);
    if (!member) throw new Error(`session member insert failed: ${template.id}`);
    return member;
  }

  async function reconcileProjectSessionMembers(project: WorkplaceProject): Promise<void> {
    const desired = new Map(project.memberTemplates.map((template) => [template.id, template]));
    const sessions = store.listSessions({ projectId: project.id, state: 'active', archived: false });
    for (const session of sessions) {
      const members = store.listSessionMembers(session.id);
      const bound = members.filter((member) => member.templateId !== null);
      for (const member of bound) {
        const template = desired.get(member.templateId as string);
        if (!template) {
          removeSessionMemberBinding(ctx, member);
          continue;
        }
        store.updateSessionMember(session.id, member.memberId, {
          type: template.type,
          data: templateData(template),
          updatedAt: new Date().toISOString()
        });
      }
    }
  }

  return { addProjectSessionMemberBinding, reconcileProjectSessionMembers };
}
