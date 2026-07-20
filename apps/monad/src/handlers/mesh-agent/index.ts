import type { MonadPaths } from '@monad/environment';
import type {
  GetMeshAgentAuthSessionResponse,
  GetMeshSessionResponse,
  GetNativeAgentDeliveryResponse,
  ListMeshAgentRuntimesQuery,
  ListMeshAgentRuntimesResponse,
  ListMeshSessionsResponse,
  MeshAgentApprovalResolutionRequest,
  MeshAgentAuthSessionView,
  MeshAgentAuthStatusResponse,
  MeshAgentInputRequest,
  MeshAgentResizeRequest,
  MeshAgentUsageResponse,
  MeshConnectionSnapshot,
  MeshConvenienceEventPage,
  MeshConvenienceFrame,
  MeshEventPageRequest,
  MeshRawEvent,
  MeshRawEventPage,
  OkResponse,
  SessionId,
  StartMeshAgentAuthResponse,
  StartMeshAgentRequest,
  StartMeshAgentResponse
} from '@monad/protocol';
import type { ConfigAccess } from '#/config/manager.ts';
import type { MeshAgentHost } from '#/services/mesh-agent/host/index.ts';
import type { Store } from '#/store/db/index.ts';
import type { MeshAgentTargetId } from '#/store/db/mesh-sessions.ts';

import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  getMeshSessionResponseSchema,
  getNativeAgentDeliveryResponseSchema,
  listMeshAgentRuntimesResponseSchema,
  listMeshSessionsResponseSchema,
  meshConnectionSnapshotSchema,
  meshConvenienceEventPageSchema,
  meshConvenienceFrameSchema,
  meshRawEventPageSchema,
  meshRawEventSchema,
  startMeshAgentResponseSchema
} from '@monad/protocol';

import { HandlerError } from '#/handlers/handler-error.ts';
import { MeshAgentError } from '#/services/mesh-agent/errors.ts';

export interface MeshAgentDeps {
  paths: MonadPaths;
  host: MeshAgentHost;
  store: Store;
  config: ConfigAccess;
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

export function createMeshAgentModule({ host, store, config }: MeshAgentDeps) {
  const requireConfig = () => config.get().cfg;

  function mapMeshAgentError(error: unknown): never {
    if (error instanceof MeshAgentError) {
      const kind =
        error.code === 'unsupported_capability' || error.code === 'provider_not_logged_in' ? 'invalid' : 'bad_gateway';
      throw new HandlerError(kind, error.message, error.code);
    }
    if (error instanceof Error && error.message.includes('MeshAgent session not found')) {
      throw new HandlerError('not_found', error.message, 'MESH_SESSION_NOT_FOUND');
    }
    if (error instanceof Error && error.message.includes('MeshAgent session is not running')) {
      throw new HandlerError('conflict', error.message, 'MESH_SESSION_NOT_RUNNING');
    }
    if (error instanceof Error && error.message.includes('MeshAgent not found or disabled')) {
      throw new HandlerError('not_found', error.message, 'MESH_AGENT_NOT_FOUND');
    }
    throw error;
  }

  function requireMeshSessionScope(id: string, transcriptTargetId: MeshAgentTargetId) {
    const session = host.get(id);
    if (session.sessionId !== transcriptTargetId) {
      throw new HandlerError('not_found', `MeshAgent session not found for transcript target: ${id}`);
    }
    return session;
  }

  function mapMeshAgentAuthScopeError(id: string, error: unknown): never {
    if (error instanceof Error && error.message.includes('MeshAgent auth session not found')) {
      throw new HandlerError('not_found', `MeshAgent auth session not found: ${id}`);
    }
    throw error;
  }

  return {
    async start({ request }: { request: StartMeshAgentRequest }): Promise<StartMeshAgentResponse> {
      config.get();
      const sessionId: SessionId = request.transcriptTargetId;
      // TODO(track-b): `sessionId` is typed `SessionId` here (the id union collapse), so
      // `getWorkplaceProject(sessionId)` can no longer match anything reachable through this
      // handler's own type boundary — the /v1/sessions/:id/mesh-agent route casts to
      // `ses_${string}` before calling in (apps/monad/src/transports/http/mesh-agent.ts).
      // The parallel /v1/projects/:id/* route (untouched per this pass's scope) still exists and
      // may still reach a genuinely different code path — left as-is pending the class-C decision
      // on whether mesh-agent runtimes should still attach directly to a ProjectId at all.
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
        runtimeRole: request.runtimeRole,
        providerSessionRef: request.providerSessionRef
      });
      return startMeshAgentResponseSchema.parse({ session });
    },

    async input({
      id,
      input,
      transcriptTargetId
    }: { id: string; transcriptTargetId: MeshAgentTargetId } & MeshAgentInputRequest): Promise<OkResponse> {
      requireMeshSessionScope(id, transcriptTargetId);
      await host.input(id, { input });
      return { ok: true };
    },

    interrupt({ id, transcriptTargetId }: { id: string; transcriptTargetId: MeshAgentTargetId }): OkResponse {
      requireMeshSessionScope(id, transcriptTargetId);
      host.interrupt(id);
      return { ok: true };
    },

    steer({
      id,
      input,
      transcriptTargetId
    }: { id: string; transcriptTargetId: MeshAgentTargetId } & MeshAgentInputRequest): OkResponse {
      requireMeshSessionScope(id, transcriptTargetId);
      host.steer(id, { input });
      return { ok: true };
    },

    get({ id, transcriptTargetId }: { id: string; transcriptTargetId: MeshAgentTargetId }): GetMeshSessionResponse {
      return getMeshSessionResponseSchema.parse({
        session: requireMeshSessionScope(id, transcriptTargetId)
      });
    },

    list({ sessionId }: { sessionId: MeshAgentTargetId }): ListMeshSessionsResponse {
      return listMeshSessionsResponseSchema.parse(host.list(sessionId));
    },

    listAllSummaries(query: ListMeshAgentRuntimesQuery = {}): ListMeshAgentRuntimesResponse {
      return listMeshAgentRuntimesResponseSchema.parse(host.listAllSummaries(query));
    },

    listLive(query: ListMeshAgentRuntimesQuery = {}): ListMeshAgentRuntimesResponse {
      return listMeshAgentRuntimesResponseSchema.parse(host.listLive(query));
    },

    connectionSnapshot({
      id,
      transcriptTargetId
    }: {
      id: string;
      transcriptTargetId: MeshAgentTargetId;
    }): MeshConnectionSnapshot {
      requireMeshSessionScope(id, transcriptTargetId);
      return meshConnectionSnapshotSchema.parse(host.connectionSnapshot(id));
    },

    async getRawEvents({
      id,
      transcriptTargetId,
      request
    }: {
      id: string;
      transcriptTargetId: MeshAgentTargetId;
      request: Omit<MeshEventPageRequest, 'view'>;
    }): Promise<MeshRawEventPage> {
      try {
        requireMeshSessionScope(id, transcriptTargetId);
        return await host.rawEventsPage(id, request).then((page) => meshRawEventPageSchema.parse(page));
      } catch (error) {
        mapMeshAgentError(error);
      }
    },

    async getConvenienceEvents({
      id,
      transcriptTargetId,
      request
    }: {
      id: string;
      transcriptTargetId: MeshAgentTargetId;
      request: Omit<MeshEventPageRequest, 'view'>;
    }): Promise<MeshConvenienceEventPage> {
      try {
        requireMeshSessionScope(id, transcriptTargetId);
        return await host.convenienceEventsPage(id, request).then((page) => meshConvenienceEventPageSchema.parse(page));
      } catch (error) {
        mapMeshAgentError(error);
      }
    },

    subscribeRawObservation({
      id,
      transcriptTargetId,
      after,
      onFrame,
      onDone
    }: {
      id: string;
      transcriptTargetId: MeshAgentTargetId;
      after?: string;
      onFrame: (frame: MeshRawEvent) => void;
      onDone: () => void;
    }): { frames: MeshRawEvent[]; live: boolean; dispose: () => void } {
      requireMeshSessionScope(id, transcriptTargetId);
      const sub = host.subscribeRawObservation(
        id,
        {
          onFrame: (frame) => onFrame(meshRawEventSchema.parse(frame)),
          onDone
        },
        { after }
      );
      return { ...sub, frames: sub.frames.map((frame) => meshRawEventSchema.parse(frame)) };
    },

    subscribeConvenienceObservation({
      id,
      transcriptTargetId,
      after,
      onFrame
    }: {
      id: string;
      transcriptTargetId: MeshAgentTargetId;
      after?: string;
      onFrame: (frame: MeshConvenienceFrame, done: boolean) => void;
    }): { frames: MeshConvenienceFrame[]; live: boolean; dispose: () => void } {
      requireMeshSessionScope(id, transcriptTargetId);
      const sub = host.subscribeConvenienceObservation(
        id,
        (frame, done) => onFrame(meshConvenienceFrameSchema.parse(frame), done),
        { after }
      );
      return { ...sub, frames: sub.frames.map((frame) => meshConvenienceFrameSchema.parse(frame)) };
    },

    delivery({
      id,
      transcriptTargetId
    }: {
      id: `deliv_${string}`;
      transcriptTargetId: MeshAgentTargetId;
    }): GetNativeAgentDeliveryResponse {
      const delivery = store.getNativeAgentDelivery(id);
      if (!delivery) throw new HandlerError('not_found', `native agent delivery not found: ${id}`);
      if (delivery.sessionId !== transcriptTargetId) {
        throw new HandlerError('not_found', `native agent delivery not found for transcript target: ${id}`);
      }
      return getNativeAgentDeliveryResponseSchema.parse({ delivery });
    },

    resize({
      id,
      cols,
      rows,
      transcriptTargetId
    }: { id: string; transcriptTargetId: MeshAgentTargetId } & MeshAgentResizeRequest): OkResponse {
      requireMeshSessionScope(id, transcriptTargetId);
      host.resize(id, { cols, rows });
      return { ok: true };
    },

    approval({
      id,
      requestId,
      allow,
      reason,
      transcriptTargetId
    }: { id: string; transcriptTargetId: MeshAgentTargetId } & MeshAgentApprovalResolutionRequest): OkResponse {
      requireMeshSessionScope(id, transcriptTargetId);
      host.resolveApproval(id, { requestId, allow, reason });
      return { ok: true };
    },

    stop({ id, transcriptTargetId }: { id: string; transcriptTargetId: MeshAgentTargetId }): OkResponse {
      requireMeshSessionScope(id, transcriptTargetId);
      host.stop(id);
      return { ok: true };
    },

    async startAuth({ agentName }: { agentName: string }): Promise<StartMeshAgentAuthResponse> {
      await requireConfig();
      try {
        return { session: await host.startAuth(agentName) };
      } catch (error) {
        mapMeshAgentError(error);
      }
    },

    getAuth({ id, controlToken }: { id: string; controlToken: string }): GetMeshAgentAuthSessionResponse {
      try {
        return { session: host.getAuth(id, controlToken) };
      } catch (error) {
        mapMeshAgentAuthScopeError(id, error);
      }
    },

    subscribeAuth({
      id,
      controlToken,
      onSession
    }: {
      id: string;
      controlToken: string;
      onSession: (session: MeshAgentAuthSessionView) => void;
    }): {
      session: MeshAgentAuthSessionView;
      dispose: () => void;
    } {
      try {
        return host.subscribeAuth(id, controlToken, onSession);
      } catch (error) {
        mapMeshAgentAuthScopeError(id, error);
      }
    },

    inputAuth({ id, controlToken, input }: { id: string; controlToken: string } & MeshAgentInputRequest): OkResponse {
      try {
        host.inputAuth(id, controlToken, { input });
      } catch (error) {
        mapMeshAgentAuthScopeError(id, error);
      }
      return { ok: true };
    },

    resizeAuth({
      id,
      controlToken,
      cols,
      rows
    }: { id: string; controlToken: string } & MeshAgentResizeRequest): OkResponse {
      try {
        host.resizeAuth(id, controlToken, { cols, rows });
      } catch (error) {
        mapMeshAgentAuthScopeError(id, error);
      }
      return { ok: true };
    },

    heartbeatAuth({ id, controlToken }: { id: string; controlToken: string }): OkResponse {
      try {
        host.heartbeatAuth(id, controlToken);
      } catch (error) {
        mapMeshAgentAuthScopeError(id, error);
      }
      return { ok: true };
    },

    stopAuth({ id, controlToken }: { id: string; controlToken: string }): OkResponse {
      try {
        host.stopAuth(id, controlToken);
      } catch (error) {
        mapMeshAgentAuthScopeError(id, error);
      }
      return { ok: true };
    },

    async authStatus({ agentName }: { agentName: string }): Promise<MeshAgentAuthStatusResponse> {
      await requireConfig();
      try {
        return await host.authStatus(agentName);
      } catch (error) {
        mapMeshAgentError(error);
      }
    },

    async usage({ agentName }: { agentName: string }): Promise<MeshAgentUsageResponse> {
      await requireConfig();
      try {
        return await host.usage(agentName);
      } catch (error) {
        mapMeshAgentError(error);
      }
    }
  };
}
