import type { MonadPaths } from '@monad/home';
import type {
  ExternalAgentApprovalResolutionRequest,
  ExternalAgentAuthSessionView,
  ExternalAgentAuthStatusResponse,
  ExternalAgentHistoryPageRequest,
  ExternalAgentHistoryPageResponse,
  ExternalAgentInputRequest,
  ExternalAgentObservationAccessResponse,
  ExternalAgentResizeRequest,
  ExternalAgentUsageResponse,
  GetExternalAgentAuthSessionResponse,
  GetExternalAgentSessionResponse,
  GetNativeAgentDeliveryResponse,
  ListExternalAgentRuntimesQuery,
  ListExternalAgentRuntimesResponse,
  ListExternalAgentSessionsResponse,
  OkResponse,
  SessionId,
  StartExternalAgentAuthResponse,
  StartExternalAgentRequest,
  StartExternalAgentResponse,
  TranscriptTargetId
} from '@monad/protocol';
import type { ExternalAgentHost } from '@/services/external-agent/host/index.ts';
import type { Store } from '@/store/db/index.ts';

import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { loadAll } from '@monad/home';
import {
  externalAgentObservationAccessResponseSchema,
  getExternalAgentSessionResponseSchema,
  getNativeAgentDeliveryResponseSchema,
  listExternalAgentRuntimesResponseSchema,
  listExternalAgentSessionsResponseSchema,
  startExternalAgentResponseSchema
} from '@monad/protocol';

import { HandlerError } from '@/handlers/handler-error.ts';
import { ExternalAgentError } from '@/services/external-agent/errors.ts';

export interface ExternalAgentDeps {
  paths: MonadPaths;
  host: ExternalAgentHost;
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

export function createExternalAgentModule({ paths, host, store }: ExternalAgentDeps) {
  async function requireConfig() {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('external agent runtime: config.json missing');
    return cfg;
  }

  function mapExternalAgentError(error: unknown): never {
    if (error instanceof ExternalAgentError) {
      const kind =
        error.code === 'unsupported_capability' || error.code === 'provider_not_logged_in' ? 'invalid' : 'bad_gateway';
      throw new HandlerError(kind, error.message, error.code);
    }
    if (error instanceof Error && error.message.includes('external agent session not found')) {
      throw new HandlerError('not_found', error.message, 'EXTERNAL_AGENT_SESSION_NOT_FOUND');
    }
    if (error instanceof Error && error.message.includes('external agent session is not running')) {
      throw new HandlerError('conflict', error.message, 'EXTERNAL_AGENT_SESSION_NOT_RUNNING');
    }
    throw error;
  }

  function requireExternalAgentSessionScope(id: string, transcriptTargetId: TranscriptTargetId) {
    const session = host.get(id);
    if (session.transcriptTargetId !== transcriptTargetId) {
      throw new HandlerError('not_found', `external agent session not found for transcript target: ${id}`);
    }
    return session;
  }

  function emptyHistoryPageForUnsupported(error: unknown): ExternalAgentHistoryPageResponse | undefined {
    if (error instanceof ExternalAgentError && error.code === 'unsupported_capability') return { events: [] };
    return undefined;
  }

  function mapExternalAgentAuthScopeError(id: string, error: unknown): never {
    if (error instanceof Error && error.message.includes('external agent auth session not found')) {
      throw new HandlerError('not_found', `external agent auth session not found: ${id}`);
    }
    throw error;
  }

  return {
    async start({
      sessionId,
      request
    }: {
      sessionId: SessionId;
      request: StartExternalAgentRequest;
    }): Promise<StartExternalAgentResponse> {
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
      return startExternalAgentResponseSchema.parse({ session });
    },

    async input({
      id,
      input,
      transcriptTargetId
    }: { id: string; transcriptTargetId: TranscriptTargetId } & ExternalAgentInputRequest): Promise<OkResponse> {
      requireExternalAgentSessionScope(id, transcriptTargetId);
      await host.input(id, { input });
      return { ok: true };
    },

    interrupt({ id, transcriptTargetId }: { id: string; transcriptTargetId: TranscriptTargetId }): OkResponse {
      requireExternalAgentSessionScope(id, transcriptTargetId);
      host.interrupt(id);
      return { ok: true };
    },

    steer({
      id,
      input,
      transcriptTargetId
    }: { id: string; transcriptTargetId: TranscriptTargetId } & ExternalAgentInputRequest): OkResponse {
      requireExternalAgentSessionScope(id, transcriptTargetId);
      host.steer(id, { input });
      return { ok: true };
    },

    get({
      id,
      transcriptTargetId
    }: {
      id: string;
      transcriptTargetId: TranscriptTargetId;
    }): GetExternalAgentSessionResponse {
      return getExternalAgentSessionResponseSchema.parse({
        session: requireExternalAgentSessionScope(id, transcriptTargetId)
      });
    },

    list({ sessionId }: { sessionId: TranscriptTargetId }): ListExternalAgentSessionsResponse {
      return listExternalAgentSessionsResponseSchema.parse(host.list(sessionId));
    },

    listAllSummaries(query: ListExternalAgentRuntimesQuery = {}): ListExternalAgentRuntimesResponse {
      return listExternalAgentRuntimesResponseSchema.parse(host.listAllSummaries(query));
    },

    listLive(query: ListExternalAgentRuntimesQuery = {}): ListExternalAgentRuntimesResponse {
      return listExternalAgentRuntimesResponseSchema.parse(host.listLive(query));
    },

    observe({
      id,
      transcriptTargetId
    }: {
      id: string;
      transcriptTargetId: TranscriptTargetId;
    }): Promise<ExternalAgentObservationAccessResponse> {
      requireExternalAgentSessionScope(id, transcriptTargetId);
      return Promise.resolve(externalAgentObservationAccessResponseSchema.parse(host.observe(id)));
    },

    subscribeObservation({
      id,
      transcriptTargetId,
      onObservation,
      afterSeq
    }: {
      id: string;
      transcriptTargetId: TranscriptTargetId;
      onObservation: (access: ExternalAgentObservationAccessResponse, done: boolean) => void;
      afterSeq?: number;
    }): {
      access: ExternalAgentObservationAccessResponse;
      live: boolean;
      dispose: () => void;
    } {
      requireExternalAgentSessionScope(id, transcriptTargetId);
      return host.subscribeObservation(
        id,
        (access, done) => onObservation(externalAgentObservationAccessResponseSchema.parse(access), done),
        afterSeq
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
    }): ExternalAgentObservationAccessResponse {
      const delivery = store.getNativeAgentDelivery(id);
      if (!delivery) throw new HandlerError('not_found', `native agent delivery not found: ${id}`);
      if (delivery.projectId !== transcriptTargetId) {
        throw new HandlerError('not_found', `native agent delivery not found for transcript target: ${id}`);
      }
      requireExternalAgentSessionScope(delivery.externalAgentSessionId, transcriptTargetId);
      return externalAgentObservationAccessResponseSchema.parse({
        ...host.observe(delivery.externalAgentSessionId),
        deliveryId: id,
        turn: delivery.turn
      });
    },

    resize({
      id,
      cols,
      rows,
      transcriptTargetId
    }: { id: string; transcriptTargetId: TranscriptTargetId } & ExternalAgentResizeRequest): OkResponse {
      requireExternalAgentSessionScope(id, transcriptTargetId);
      host.resize(id, { cols, rows });
      return { ok: true };
    },

    approval({
      id,
      requestId,
      allow,
      reason,
      transcriptTargetId
    }: { id: string; transcriptTargetId: TranscriptTargetId } & ExternalAgentApprovalResolutionRequest): OkResponse {
      requireExternalAgentSessionScope(id, transcriptTargetId);
      host.resolveApproval(id, { requestId, allow, reason });
      return { ok: true };
    },

    stop({ id, transcriptTargetId }: { id: string; transcriptTargetId: TranscriptTargetId }): OkResponse {
      requireExternalAgentSessionScope(id, transcriptTargetId);
      host.stop(id);
      return { ok: true };
    },

    async historyPage({
      id,
      transcriptTargetId,
      request
    }: {
      id: string;
      transcriptTargetId: TranscriptTargetId;
      request: ExternalAgentHistoryPageRequest;
    }): Promise<ExternalAgentHistoryPageResponse> {
      try {
        requireExternalAgentSessionScope(id, transcriptTargetId);
        return await host.historyPage(id, request);
      } catch (error) {
        const empty = emptyHistoryPageForUnsupported(error);
        if (empty) return empty;
        mapExternalAgentError(error);
      }
    },

    async startAuth({ agentName }: { agentName: string }): Promise<StartExternalAgentAuthResponse> {
      await requireConfig();
      return { session: await host.startAuth(agentName) };
    },

    getAuth({ id, controlToken }: { id: string; controlToken: string }): GetExternalAgentAuthSessionResponse {
      try {
        return { session: host.getAuth(id, controlToken) };
      } catch (error) {
        mapExternalAgentAuthScopeError(id, error);
      }
    },

    subscribeAuth({
      id,
      controlToken,
      onSession
    }: {
      id: string;
      controlToken: string;
      onSession: (session: ExternalAgentAuthSessionView) => void;
    }): {
      session: ExternalAgentAuthSessionView;
      dispose: () => void;
    } {
      try {
        return host.subscribeAuth(id, controlToken, onSession);
      } catch (error) {
        mapExternalAgentAuthScopeError(id, error);
      }
    },

    inputAuth({
      id,
      controlToken,
      input
    }: { id: string; controlToken: string } & ExternalAgentInputRequest): OkResponse {
      try {
        host.inputAuth(id, controlToken, { input });
      } catch (error) {
        mapExternalAgentAuthScopeError(id, error);
      }
      return { ok: true };
    },

    resizeAuth({
      id,
      controlToken,
      cols,
      rows
    }: { id: string; controlToken: string } & ExternalAgentResizeRequest): OkResponse {
      try {
        host.resizeAuth(id, controlToken, { cols, rows });
      } catch (error) {
        mapExternalAgentAuthScopeError(id, error);
      }
      return { ok: true };
    },

    heartbeatAuth({ id, controlToken }: { id: string; controlToken: string }): OkResponse {
      try {
        host.heartbeatAuth(id, controlToken);
      } catch (error) {
        mapExternalAgentAuthScopeError(id, error);
      }
      return { ok: true };
    },

    stopAuth({ id, controlToken }: { id: string; controlToken: string }): OkResponse {
      try {
        host.stopAuth(id, controlToken);
      } catch (error) {
        mapExternalAgentAuthScopeError(id, error);
      }
      return { ok: true };
    },

    async authStatus({ agentName }: { agentName: string }): Promise<ExternalAgentAuthStatusResponse> {
      await requireConfig();
      try {
        return await host.authStatus(agentName);
      } catch (error) {
        mapExternalAgentError(error);
      }
    },

    async usage({ agentName }: { agentName: string }): Promise<ExternalAgentUsageResponse> {
      await requireConfig();
      try {
        return await host.usage(agentName);
      } catch (error) {
        mapExternalAgentError(error);
      }
    }
  };
}
