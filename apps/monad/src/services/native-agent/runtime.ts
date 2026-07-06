import type { NativeAgentRuntime, NativeAgentRuntimeInfoResponse, ProjectId } from '@monad/protocol';
import type { createDaemonHandlers } from '@/handlers/daemon-handlers/index.ts';
import type { NativeCliSessionRow } from '@/store/db/index.ts';

import { createHash, timingSafeEqual } from 'node:crypto';
import { nativeAgentRuntimeSchema } from '@monad/protocol';

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

function runtimeSummary(nativeSession: NativeCliSessionRow): NativeAgentRuntime {
  return nativeAgentRuntimeSchema.parse({
    id: nativeSession.id,
    transcriptTargetId: nativeSession.transcriptTargetId,
    agentName: nativeSession.agentName,
    provider: nativeSession.provider,
    workingPath: nativeSession.workingPath,
    launchMode: nativeSession.launchMode,
    runtimeRole: nativeSession.runtimeRole,
    agentRuntimeId: nativeSession.agentRuntimeId,
    state: nativeSession.state,
    session: { providerSessionRef: nativeSession.providerSessionRef },
    lastDeliveredSeq: nativeSession.lastDeliveredSeq,
    lastVisibleSeq: nativeSession.lastVisibleSeq,
    pendingApprovalCount: 0,
    startedAt: nativeSession.startedAt,
    updatedAt: nativeSession.updatedAt,
    exitedAt: nativeSession.exitedAt
  });
}

export function createNativeAgentRuntimeService(handlers: ReturnType<typeof createDaemonHandlers>) {
  const store = handlers._nativeAgentStore;
  return {
    requireManagedBinding(headers: Headers): {
      binding: NativeAgentRuntimeBinding;
      nativeSession: NativeCliSessionRow;
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
      nativeSession: NativeCliSessionRow;
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
        pendingInboxCount: store.countNativeCliInbox(args.binding.nativeCliSessionId)
      };
    }
  };
}
