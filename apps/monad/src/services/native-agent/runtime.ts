import type { NativeAgentRuntime, NativeAgentRuntimeInfoResponse, SessionId } from '@monad/protocol';
import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';
import type { MeshSessionRow } from '#/store/db/index.ts';

import { createHash, timingSafeEqual } from 'node:crypto';
import { nativeAgentRuntimeSchema } from '@monad/protocol';

import { HandlerError } from '#/handlers/handler-error.ts';
import { toView } from '#/services/mesh-agent/host/host-helpers.ts';

export interface NativeAgentRuntimeBinding {
  agentId: string;
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
      return {
        binding: {
          agentId: nativeSession.agentName,
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
      return {
        ...args.binding,
        runtime: runtimeSummary(args.nativeSession),
        serverUrl: args.serverUrl,
        workdir: args.nativeSession.workingPath,
        providerSessionRef: args.nativeSession.providerSessionRef,
        lastDeliveredSeq: args.nativeSession.lastDeliveredSeq,
        lastVisibleSeq: args.nativeSession.lastVisibleSeq,
        pendingInboxCount: store.countMeshAgentInbox(args.binding.meshSessionId)
      };
    }
  };
}
