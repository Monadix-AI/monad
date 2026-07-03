import type { MonadPaths } from '@monad/home';
import type {
  GetNativeAgentDeliveryResponse,
  GetNativeCliAuthSessionResponse,
  GetNativeCliSessionResponse,
  ListNativeCliSessionsResponse,
  NativeCliApprovalResolutionRequest,
  NativeCliAuthSessionView,
  NativeCliAuthStatusResponse,
  NativeCliHistoryPageRequest,
  NativeCliHistoryPageResponse,
  NativeCliInputRequest,
  NativeCliObservationAccessResponse,
  NativeCliResizeRequest,
  NativeCliUsageResponse,
  OkResponse,
  SessionId,
  StartNativeCliAgentRequest,
  StartNativeCliAgentResponse,
  StartNativeCliAuthResponse,
  TranscriptTargetId
} from '@monad/protocol';
import type { NativeCliHost } from '@/services/native-cli/host.ts';
import type { Store } from '@/store/db/index.ts';

import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { loadAll } from '@monad/home';
import {
  getNativeAgentDeliveryResponseSchema,
  getNativeCliSessionResponseSchema,
  listNativeCliSessionsResponseSchema,
  nativeCliObservationAccessResponseSchema,
  startNativeCliAgentResponseSchema
} from '@monad/protocol';

import { HandlerError } from '@/handlers/handler-error.ts';
import { NativeCliError } from '@/services/native-cli/errors.ts';

export interface NativeCliDeps {
  paths: MonadPaths;
  host: NativeCliHost;
  store: Store;
}

function realOrResolve(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** True when `target` is `base` or nested under it (no `..` escape). Both are realpath-normalized so a
 *  symlinked workingPath is judged by where it actually points (matching how the host resolves cwd). */
function isWithin(base: string, target: string): boolean {
  const rel = relative(realOrResolve(base), realOrResolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function createNativeCliModule({ paths, host, store }: NativeCliDeps) {
  async function requireConfig() {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('native CLI runtime: config.json missing');
    return cfg;
  }

  function mapNativeCliError(error: unknown): never {
    if (error instanceof NativeCliError) {
      const kind =
        error.code === 'unsupported_capability' || error.code === 'provider_not_logged_in' ? 'invalid' : 'bad_gateway';
      throw new HandlerError(kind, error.message, error.code);
    }
    throw error;
  }

  function requireNativeCliSessionScope(id: string, transcriptTargetId: TranscriptTargetId) {
    const session = host.get(id);
    if (session.transcriptTargetId !== transcriptTargetId) {
      throw new HandlerError('not_found', `native CLI session not found for transcript target: ${id}`);
    }
    return session;
  }

  function mapNativeCliAuthScopeError(id: string, error: unknown): never {
    if (error instanceof Error && error.message.includes('native CLI auth session not found')) {
      throw new HandlerError('not_found', `native CLI auth session not found: ${id}`);
    }
    throw error;
  }

  return {
    async start({
      sessionId,
      request
    }: {
      sessionId: SessionId;
      request: StartNativeCliAgentRequest;
    }): Promise<StartNativeCliAgentResponse> {
      await requireConfig();
      const project = store.getSession(sessionId) ?? store.getWorkplaceProject(sessionId);
      if (!project) throw new HandlerError('not_found', `project not found: ${sessionId}`);
      // When the project pins a working folder, the CLI must launch within it so the direct API
      // can't start an agent outside the project root.
      if (project.cwd && !isWithin(project.cwd, request.workingPath)) {
        throw new HandlerError('invalid', `workingPath must be within the project working directory: ${project.cwd}`);
      }
      const session = await host.start({
        transcriptTargetId: sessionId,
        agentName: request.agentName,
        workingPath: request.workingPath,
        launchMode: request.launchMode,
        runtimeRole: request.runtimeRole,
        providerSessionRef: request.providerSessionRef
      });
      return startNativeCliAgentResponseSchema.parse({ session });
    },

    input({
      id,
      input,
      transcriptTargetId
    }: { id: string; transcriptTargetId: TranscriptTargetId } & NativeCliInputRequest): OkResponse {
      requireNativeCliSessionScope(id, transcriptTargetId);
      host.input(id, { input });
      return { ok: true };
    },

    get({
      id,
      transcriptTargetId
    }: {
      id: string;
      transcriptTargetId: TranscriptTargetId;
    }): GetNativeCliSessionResponse {
      return getNativeCliSessionResponseSchema.parse({ session: requireNativeCliSessionScope(id, transcriptTargetId) });
    },

    list({ sessionId }: { sessionId: TranscriptTargetId }): ListNativeCliSessionsResponse {
      return listNativeCliSessionsResponseSchema.parse(host.list(sessionId));
    },

    observe({
      id,
      transcriptTargetId
    }: {
      id: string;
      transcriptTargetId: TranscriptTargetId;
    }): NativeCliObservationAccessResponse {
      requireNativeCliSessionScope(id, transcriptTargetId);
      return nativeCliObservationAccessResponseSchema.parse(host.observe(id));
    },

    subscribeObservation({
      id,
      transcriptTargetId,
      onObservation
    }: {
      id: string;
      transcriptTargetId: TranscriptTargetId;
      onObservation: (access: NativeCliObservationAccessResponse, done: boolean) => void;
    }): {
      access: NativeCliObservationAccessResponse;
      live: boolean;
      dispose: () => void;
    } {
      requireNativeCliSessionScope(id, transcriptTargetId);
      return host.subscribeObservation(id, (access, done) =>
        onObservation(nativeCliObservationAccessResponseSchema.parse(access), done)
      );
    },

    delivery({
      id,
      transcriptTargetId
    }: {
      id: `deliv_${string}`;
      transcriptTargetId: TranscriptTargetId;
    }): GetNativeAgentDeliveryResponse {
      const delivery = store.getNativeAgentDelivery(id);
      if (!delivery) throw new HandlerError('not_found', `native agent delivery not found: ${id}`);
      if (delivery.projectId !== transcriptTargetId) {
        throw new HandlerError('not_found', `native agent delivery not found for transcript target: ${id}`);
      }
      return getNativeAgentDeliveryResponseSchema.parse({ delivery });
    },

    observeDelivery({
      id,
      transcriptTargetId
    }: {
      id: `deliv_${string}`;
      transcriptTargetId: TranscriptTargetId;
    }): NativeCliObservationAccessResponse {
      const delivery = store.getNativeAgentDelivery(id);
      if (!delivery) throw new HandlerError('not_found', `native agent delivery not found: ${id}`);
      if (delivery.projectId !== transcriptTargetId) {
        throw new HandlerError('not_found', `native agent delivery not found for transcript target: ${id}`);
      }
      requireNativeCliSessionScope(delivery.nativeCliSessionId, transcriptTargetId);
      return nativeCliObservationAccessResponseSchema.parse({
        ...host.observe(delivery.nativeCliSessionId),
        deliveryId: id,
        turn: delivery.turn
      });
    },

    resize({
      id,
      cols,
      rows,
      transcriptTargetId
    }: { id: string; transcriptTargetId: TranscriptTargetId } & NativeCliResizeRequest): OkResponse {
      requireNativeCliSessionScope(id, transcriptTargetId);
      host.resize(id, { cols, rows });
      return { ok: true };
    },

    approval({
      id,
      requestId,
      allow,
      reason,
      transcriptTargetId
    }: { id: string; transcriptTargetId: TranscriptTargetId } & NativeCliApprovalResolutionRequest): OkResponse {
      requireNativeCliSessionScope(id, transcriptTargetId);
      host.resolveApproval(id, { requestId, allow, reason });
      return { ok: true };
    },

    stop({ id, transcriptTargetId }: { id: string; transcriptTargetId: TranscriptTargetId }): OkResponse {
      requireNativeCliSessionScope(id, transcriptTargetId);
      host.stop(id);
      return { ok: true };
    },

    historyPage({
      id,
      transcriptTargetId,
      request
    }: {
      id: string;
      transcriptTargetId: TranscriptTargetId;
      request: NativeCliHistoryPageRequest;
    }): Promise<NativeCliHistoryPageResponse> {
      try {
        requireNativeCliSessionScope(id, transcriptTargetId);
        return host.historyPage(id, request).catch(mapNativeCliError);
      } catch (error) {
        mapNativeCliError(error);
      }
    },

    async startAuth({ agentName }: { agentName: string }): Promise<StartNativeCliAuthResponse> {
      await requireConfig();
      return { session: await host.startAuth(agentName) };
    },

    getAuth({ id, controlToken }: { id: string; controlToken: string }): GetNativeCliAuthSessionResponse {
      try {
        return { session: host.getAuth(id, controlToken) };
      } catch (error) {
        mapNativeCliAuthScopeError(id, error);
      }
    },

    subscribeAuth({
      id,
      controlToken,
      onSession
    }: {
      id: string;
      controlToken: string;
      onSession: (session: NativeCliAuthSessionView) => void;
    }): {
      session: NativeCliAuthSessionView;
      dispose: () => void;
    } {
      try {
        return host.subscribeAuth(id, controlToken, onSession);
      } catch (error) {
        mapNativeCliAuthScopeError(id, error);
      }
    },

    inputAuth({ id, controlToken, input }: { id: string; controlToken: string } & NativeCliInputRequest): OkResponse {
      try {
        host.inputAuth(id, controlToken, { input });
      } catch (error) {
        mapNativeCliAuthScopeError(id, error);
      }
      return { ok: true };
    },

    resizeAuth({
      id,
      controlToken,
      cols,
      rows
    }: { id: string; controlToken: string } & NativeCliResizeRequest): OkResponse {
      try {
        host.resizeAuth(id, controlToken, { cols, rows });
      } catch (error) {
        mapNativeCliAuthScopeError(id, error);
      }
      return { ok: true };
    },

    heartbeatAuth({ id, controlToken }: { id: string; controlToken: string }): OkResponse {
      try {
        host.heartbeatAuth(id, controlToken);
      } catch (error) {
        mapNativeCliAuthScopeError(id, error);
      }
      return { ok: true };
    },

    stopAuth({ id, controlToken }: { id: string; controlToken: string }): OkResponse {
      try {
        host.stopAuth(id, controlToken);
      } catch (error) {
        mapNativeCliAuthScopeError(id, error);
      }
      return { ok: true };
    },

    async authStatus({ agentName }: { agentName: string }): Promise<NativeCliAuthStatusResponse> {
      await requireConfig();
      try {
        return await host.authStatus(agentName);
      } catch (error) {
        mapNativeCliError(error);
      }
    },

    async usage({ agentName }: { agentName: string }): Promise<NativeCliUsageResponse> {
      await requireConfig();
      try {
        return await host.usage(agentName);
      } catch (error) {
        mapNativeCliError(error);
      }
    }
  };
}
