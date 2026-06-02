import type { NativeAgentSessionMembersResponse, SessionBinding, SessionId } from '@monad/protocol';
import type { Store } from '#/store/db/index.ts';

import { nativeAgentSessionMembersResponseSchema } from '@monad/protocol';

import { HandlerError } from '#/handlers/handler-error.ts';

export interface NativeAgentSessionMembersDeps {
  store: Store;
}

// A member is online iff its binding is active and points at a live NativeRuntimeSession that is genuinely
// its own: the runtime row exists, is a managed-project-agent, belongs to this session, is owned by this
// exact project member, and is still running. A dangling / terminal / wrong-owner / superseded current id
// is not online — a non-null cursor alone is not proof of a live runtime.
function isMemberOnline(store: Store, sessionId: SessionId, binding: SessionBinding): boolean {
  if (binding.lifecycle !== 'active') return false;
  const current = binding.currentNativeRuntimeSessionId;
  if (!current) return false;
  const runtime = store.getMeshSession(current);
  return (
    !!runtime &&
    runtime.runtimeRole === 'managed-project-agent' &&
    runtime.transcriptTargetId === sessionId &&
    runtime.projectMemberId === binding.projectMemberId &&
    runtime.state === 'running'
  );
}

export function createNativeAgentSessionMembersService(deps: NativeAgentSessionMembersDeps) {
  return {
    async list(sessionId: SessionId, requesterProjectMemberId: string): Promise<NativeAgentSessionMembersResponse> {
      const session = deps.store.getSession(sessionId);
      const members: { id: string; displayName: string; status: 'online' | 'offline' }[] = [];
      if (!session?.projectId) return nativeAgentSessionMembersResponseSchema.parse({ members });
      // Canonical roster: the session's non-left bindings joined to their ProjectMember identity. The
      // requester excludes itself by projectMemberId. A binding with no ProjectMember is a corrupted graph
      // — fail closed rather than return a partial roster. Legacy SessionMember rows, `data.instanceId`, and
      // runtime aliases are never consulted.
      for (const binding of deps.store.listSessionBindings(sessionId)) {
        if (binding.lifecycle === 'left') continue;
        if (binding.projectMemberId === requesterProjectMemberId) continue;
        const member = deps.store.getProjectMember(session.projectId, binding.projectMemberId);
        if (!member) {
          throw new HandlerError(
            'internal',
            `session member binding has no project member: ${binding.projectMemberId}`
          );
        }
        members.push({
          id: member.id,
          displayName: member.displayName,
          status: isMemberOnline(deps.store, sessionId, binding) ? 'online' : 'offline'
        });
      }
      return nativeAgentSessionMembersResponseSchema.parse({ members });
    }
  };
}
