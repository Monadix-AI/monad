import type { NativeAgentRuntimeInfoResponse, ProjectId } from '@monad/protocol';
import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import { createHash, timingSafeEqual } from 'node:crypto';

import { HandlerError } from '@/handlers/handler-error.ts';

export interface NativeAgentRuntimeBinding {
  agentId: string;
  projectId: ProjectId;
  nativeCliSessionId: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function tokenMatchesHash(providedToken: string, expectedHash: string): boolean {
  const provided = Buffer.from(hashToken(providedToken), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function createNativeAgentRuntimeService(handlers: ReturnType<typeof createDaemonHandlers>) {
  const store = handlers._nativeAgentStore;
  return {
    requireManagedBinding(headers: Headers): {
      binding: NativeAgentRuntimeBinding;
      nativeSession: NonNullable<ReturnType<typeof store.getNativeCliSession>>;
    } {
      const nativeCliSessionId = headers.get('x-monad-native-cli-session-id');
      if (!nativeCliSessionId) {
        throw new HandlerError(
          'forbidden',
          'current runtime is not a project-managed native CLI agent',
          'NOT_MANAGED_NATIVE_CLI'
        );
      }
      const nativeSession = store.getNativeCliSession(nativeCliSessionId);
      if (!nativeSession) {
        throw new HandlerError(
          'not_found',
          `native CLI session not found: ${nativeCliSessionId}`,
          'NATIVE_CLI_SESSION_NOT_FOUND'
        );
      }
      if (nativeSession.runtimeRole !== 'managed-project-agent') {
        throw new HandlerError(
          'forbidden',
          'current runtime is not a project-managed native CLI agent',
          'NOT_MANAGED_NATIVE_CLI'
        );
      }
      if (nativeSession.state !== 'running') {
        throw new HandlerError(
          'forbidden',
          'managed native CLI session is not active',
          'NATIVE_CLI_SESSION_NOT_ACTIVE'
        );
      }
      if (!nativeSession.transcriptTargetId.startsWith('prj_')) {
        throw new HandlerError(
          'forbidden',
          'managed native CLI session is not bound to a Workplace Project',
          'NOT_PROJECT_MANAGED_NATIVE_CLI'
        );
      }
      const token = headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
      if (!nativeSession.agentRuntimeTokenHash || !tokenMatchesHash(token, nativeSession.agentRuntimeTokenHash)) {
        throw new HandlerError('forbidden', 'invalid managed native CLI agent token', 'INVALID_NATIVE_AGENT_TOKEN');
      }
      return {
        binding: {
          agentId: nativeSession.agentName,
          projectId: nativeSession.transcriptTargetId as ProjectId,
          nativeCliSessionId
        },
        nativeSession
      };
    },

    info(args: {
      binding: NativeAgentRuntimeBinding;
      nativeSession: NonNullable<ReturnType<typeof store.getNativeCliSession>>;
      serverUrl: string;
    }): NativeAgentRuntimeInfoResponse {
      return {
        ...args.binding,
        serverUrl: args.serverUrl,
        workdir: args.nativeSession.workingPath,
        providerSessionRef: args.nativeSession.providerSessionRef,
        lastDeliveredSeq: args.nativeSession.lastDeliveredSeq,
        lastVisibleSeq: args.nativeSession.lastVisibleSeq,
        pendingInboxCount: store.countNativeCliInbox(args.binding.nativeCliSessionId)
      };
    }
  };
}
