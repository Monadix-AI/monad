import type { SessionContext } from '#/handlers/session/context.ts';
import type { SessionMember } from '#/store/db/session-members.ts';

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
