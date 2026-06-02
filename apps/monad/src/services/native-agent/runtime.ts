import type { NativeAgentRuntime, NativeAgentRuntimeInfoResponse, SessionId } from '@monad/protocol';
import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';
import type { MeshSessionRow } from '#/store/db/index.ts';

import { createHash, timingSafeEqual } from 'node:crypto';
import { nativeAgentRuntimeSchema } from '@monad/protocol';

import { HandlerError } from '#/handlers/handler-error.ts';
import { toView } from '#/services/mesh-agent/host/host-helpers.ts';

export interface NativeAgentRuntimeBinding {
  projectMemberId: string;
  sessionId: SessionId;
  meshSessionId: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function tokenMatchesHash(providedToken: string, expectedHash: string): boolean {
  const provided = Buffer.from(hashToken(providedToken), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function runtimeSummary(nativeSession: MeshSessionRow): NativeAgentRuntime {
  const view = toView(nativeSession);
  return nativeAgentRuntimeSchema.parse({
    ...view,
    session: { providerSessionRef: nativeSession.providerSessionRef }
  });
}

export function createNativeAgentRuntimeService(handlers: ReturnType<typeof createDaemonHandlers>) {
  const store = handlers._nativeAgentStore;
  return {
    requireManagedBinding(headers: Headers): {
      binding: NativeAgentRuntimeBinding;
      nativeSession: MeshSessionRow;
    } {
      const meshSessionId = headers.get('x-monad-mesh-session-id');
      if (!meshSessionId) {
        throw new HandlerError(
          'forbidden',
          'current runtime is not a project-managed MeshAgent',
          'NOT_MANAGED_MESH_AGENT'
        );
      }
      const nativeSession = store.getMeshSession(meshSessionId);
      if (!nativeSession) {
        throw new HandlerError('not_found', `MeshAgent session not found: ${meshSessionId}`, 'MESH_SESSION_NOT_FOUND');
      }
      if (nativeSession.runtimeRole !== 'managed-project-agent') {
        throw new HandlerError(
          'forbidden',
          'current runtime is not a project-managed MeshAgent',
          'NOT_MANAGED_MESH_AGENT'
        );
      }
      if (nativeSession.state !== 'running') {
        throw new HandlerError('forbidden', 'managed MeshAgent session is not active', 'MESH_SESSION_NOT_ACTIVE');
      }
      const token = headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
      if (!nativeSession.agentRuntimeTokenHash || !tokenMatchesHash(token, nativeSession.agentRuntimeTokenHash)) {
        throw new HandlerError('forbidden', 'invalid managed MeshAgent token', 'INVALID_NATIVE_AGENT_TOKEN');
      }
      // Canonical identity is the runtime's persisted owning ProjectMember (stamped and validated by
      // replaceSessionBindingRuntime), never inferred from the display agentName. A managed runtime with no
      // owning member is unbound — fail closed rather than route on the alias.
      if (!nativeSession.projectMemberId) {
        throw new HandlerError(
          'forbidden',
          'managed MeshAgent runtime has no owning project member',
          'NOT_MANAGED_MESH_AGENT'
        );
      }
      // Current-runtime fence: only the runtime the member's authoritative SessionBinding currently points
      // at may act. A superseded/replaced runtime can still be `running` (its terminal callback is late),
      // and its token is still valid — without this check it would keep posting/consuming/asking behind the
      // new owner, defeating the S2/S3 current-id fencing. Bind strictly to the binding's current runtime;
      // never fall back to the legacy row or alias.
      const binding = store.getSessionBinding(nativeSession.transcriptTargetId, nativeSession.projectMemberId);
      if (binding?.lifecycle !== 'active' || binding.currentNativeRuntimeSessionId !== meshSessionId) {
        throw new HandlerError(
          'forbidden',
          'managed MeshAgent runtime is not the current runtime for its project member',
          'MESH_SESSION_NOT_CURRENT'
        );
      }
      return {
        binding: {
          projectMemberId: nativeSession.projectMemberId,
          sessionId: nativeSession.transcriptTargetId,
          meshSessionId
        },
        nativeSession
      };
    },

    info(args: {
      binding: NativeAgentRuntimeBinding;
      nativeSession: MeshSessionRow;
      serverUrl: string;
    }): NativeAgentRuntimeInfoResponse {
      // The managed mesh cursor is frozen; the authoritative delivery watermark is the SessionBinding's.
      const cursor = store.meshAgentInboxCursor(args.binding.meshSessionId);
      return {
        ...args.binding,
        runtime: {
          ...runtimeSummary(args.nativeSession),
          lastDeliveredSeq: cursor.deliveredSeq,
          lastVisibleSeq: cursor.visibleSeq
        },
        serverUrl: args.serverUrl,
        workdir: args.nativeSession.workingPath,
        providerSessionRef: args.nativeSession.providerSessionRef,
        lastDeliveredSeq: cursor.deliveredSeq,
        lastVisibleSeq: cursor.visibleSeq,
        pendingInboxCount: store.countMeshAgentInbox(args.binding.meshSessionId)
      };
    }
  };
}
