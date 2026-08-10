import type {
  MeshAgentView,
  NativeAgentSessionMembersResponse,
  ProjectMember,
  SessionBinding,
  SessionId
} from '@monad/protocol';
import type { Store } from '#/store/db/index.ts';

import { nativeAgentSessionMembersResponseSchema } from '@monad/protocol';

import { HandlerError } from '#/handlers/handler-error.ts';

export interface NativeAgentSessionMembersDeps {
  meshAgents?: () => readonly MeshAgentView[];
  store: Store;
}

function memberAgent(deps: NativeAgentSessionMembersDeps, member: ProjectMember): MeshAgentView | undefined {
  const agents = deps.meshAgents?.() ?? [];
  if (agents.length === 0) return undefined;
  const direct = agents.find((agent) => agent.name === member.profileId);
  if (direct) return direct;
  const project = deps.store.getWorkplaceProject(member.projectId);
  const profileName = project?.memberTemplates.find((template) => template.id === member.profileId)?.name;
  return profileName ? agents.find((agent) => agent.name === profileName) : undefined;
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
      const members: NativeAgentSessionMembersResponse['members'] = [];
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
        const agent = memberAgent(deps, member);
        const displayName =
          agent?.displayName && (member.displayName === member.profileId || member.displayName === agent.name)
            ? agent.displayName
            : member.displayName;
        members.push({
          id: member.id,
          displayName,
          ...(agent?.provider ? { provider: agent.provider } : {}),
          ...(agent?.productIcon ? { productIcon: agent.productIcon } : {}),
          status: isMemberOnline(deps.store, sessionId, binding) ? 'online' : 'offline'
        });
      }
      return nativeAgentSessionMembersResponseSchema.parse({ members });
    }
  };
}
