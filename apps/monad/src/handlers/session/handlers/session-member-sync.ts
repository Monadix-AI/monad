import type { Session } from '@monad/protocol';
import type { Store } from '@/store/db/index.ts';

import { parseWorkplaceProjectMembers, workplaceProjectMembersExtKey } from '@monad/protocol';

interface SessionMemberData extends Record<string, unknown> {
  name: string;
  templateName?: string;
  displayName?: string;
  instanceId: string;
  settings?: unknown;
}

/** Materializes `session_members` (Track B live bindings) for one session from its project's
 *  `memberTemplates` roster (the config preset stored on `WorkplaceProject.origin.ext`). Inserts
 *  rows for templates the session doesn't have yet, updates rows whose template data changed, and
 *  removes rows for templates no longer on the roster — an invited member keeps its own
 *  `externalAgentSessionId` binding across syncs (patch never touches that column). No-op for a
 *  session that isn't under a project. */
export function syncSessionMembersFromProjectTemplates(store: Store, session: Session): void {
  if (!session.projectId) return;
  const project = store.getWorkplaceProject(session.projectId);
  if (!project) return;
  const templates = parseWorkplaceProjectMembers(
    (project.origin?.ext as Record<string, unknown> | undefined)?.[workplaceProjectMembersExtKey]
  );
  const now = new Date().toISOString();
  const existing = new Map(store.listSessionMembers(session.id).map((member) => [member.memberId, member]));
  const templateIds = new Set<string>();
  for (const template of templates) {
    templateIds.add(template.id);
    const data: SessionMemberData = {
      name: template.name,
      instanceId: template.instanceId ?? template.id,
      ...(template.templateName ? { templateName: template.templateName } : {}),
      ...(template.displayName ? { displayName: template.displayName } : {}),
      ...(template.settings ? { settings: template.settings } : {})
    };
    const current = existing.get(template.id);
    if (!current) {
      store.insertSessionMember({
        sessionId: session.id,
        memberId: template.id,
        templateId: template.id,
        type: template.type,
        data,
        createdAt: now,
        updatedAt: now
      });
      continue;
    }
    if (JSON.stringify(current.data) !== JSON.stringify(data)) {
      store.updateSessionMember(session.id, template.id, { data, updatedAt: now });
    }
  }
  for (const memberId of existing.keys()) {
    if (!templateIds.has(memberId)) store.deleteSessionMember(session.id, memberId);
  }
}
