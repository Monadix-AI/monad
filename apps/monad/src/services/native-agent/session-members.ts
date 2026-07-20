import type { MeshAgentConfig } from '@monad/environment';
import type { NativeAgentSessionMembersResponse, SessionId } from '@monad/protocol';
import type { MeshAgentHost } from '#/services/mesh-agent/host/index.ts';
import type { Store } from '#/store/db/index.ts';

import { nativeAgentSessionMembersResponseSchema } from '@monad/protocol';

import { managedMeshAgentProjectMembers } from '#/handlers/session/handlers/messaging-members.ts';

export interface NativeAgentSessionMembersDeps {
  store: Store;
  meshAgentHost: Pick<MeshAgentHost, 'list' | 'preflight'>;
  meshAgents(): readonly MeshAgentConfig[];
}

export function createNativeAgentSessionMembersService(deps: NativeAgentSessionMembersDeps) {
  return {
    async list(sessionId: SessionId, requesterAgentId: string): Promise<NativeAgentSessionMembersResponse> {
      const members = deps.store.listSessionMembers(sessionId).filter((member) => {
        const data = member.data as { instanceId?: string };
        return (data.instanceId ?? member.memberId) !== requesterAgentId;
      });
      const session = deps.store.getSession(sessionId);
      const managed = managedMeshAgentProjectMembers(deps.store, sessionId, deps.meshAgents());
      const managedByRuntimeName = new Map(managed.map((member) => [member.runtimeAgentName, member]));
      const readinessByTemplate = new Map<string, Promise<boolean>>();
      const activeAgentNames = new Set<string>();
      try {
        for (const runtime of deps.meshAgentHost.list(sessionId).sessions) {
          if (
            runtime.runtimeRole === 'managed-project-agent' &&
            runtime.lifecycle.state === 'active' &&
            runtime.capabilities.input
          ) {
            activeAgentNames.add(runtime.agentName);
          }
        }
      } catch {
        // Per-member preflight below remains the fail-closed fallback.
      }

      const resolved = await Promise.all(
        members.map(async (member) => {
          const data = member.data as { displayName?: string; instanceId?: string; name?: string };
          const id = data.instanceId ?? member.memberId;
          const displayName = data.displayName ?? data.name ?? member.memberId;
          const candidate = managedByRuntimeName.get(id);
          if (!session?.cwd || !candidate) return { id, displayName, status: 'offline' as const };
          if (activeAgentNames.has(id)) return { id, displayName, status: 'online' as const };
          let ready = readinessByTemplate.get(candidate.templateAgentName);
          if (!ready) {
            ready = deps.meshAgentHost
              .preflight(candidate.templateAgentName)
              .then((preflight) => preflight.state === 'ready')
              .catch(() => false);
            readinessByTemplate.set(candidate.templateAgentName, ready);
          }
          return { id, displayName, status: (await ready) ? ('online' as const) : ('offline' as const) };
        })
      );

      return nativeAgentSessionMembersResponseSchema.parse({ members: resolved });
    }
  };
}
