import type { MonadPaths } from '@monad/home';
import type {
  GetNativeCliAuthSessionResponse,
  GetNativeCliSessionResponse,
  ListNativeCliSessionsResponse,
  NativeCliApprovalResolutionRequest,
  NativeCliAuthSessionView,
  NativeCliAuthStatusResponse,
  NativeCliHistoryPageRequest,
  NativeCliHistoryPageResponse,
  NativeCliInputRequest,
  NativeCliResizeRequest,
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
  getNativeCliSessionResponseSchema,
  listNativeCliSessionsResponseSchema,
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

    input({ id, input }: { id: string } & NativeCliInputRequest): OkResponse {
      host.input(id, { input });
      return { ok: true };
    },

    get({ id }: { id: string }): GetNativeCliSessionResponse {
      return getNativeCliSessionResponseSchema.parse({ session: host.get(id) });
    },

    list({ sessionId }: { sessionId: TranscriptTargetId }): ListNativeCliSessionsResponse {
      return listNativeCliSessionsResponseSchema.parse(host.list(sessionId));
    },

    resize({ id, cols, rows }: { id: string } & NativeCliResizeRequest): OkResponse {
      host.resize(id, { cols, rows });
      return { ok: true };
    },

    approval({ id, requestId, allow, reason }: { id: string } & NativeCliApprovalResolutionRequest): OkResponse {
      host.resolveApproval(id, { requestId, allow, reason });
      return { ok: true };
    },

    stop({ id }: { id: string }): OkResponse {
      host.stop(id);
      return { ok: true };
    },

    historyPage({
      id,
      request
    }: {
      id: string;
      request: NativeCliHistoryPageRequest;
    }): Promise<NativeCliHistoryPageResponse> {
      try {
        return host.historyPage(id, request).catch(mapNativeCliError);
      } catch (error) {
        mapNativeCliError(error);
      }
    },

    async startAuth({ agentName }: { agentName: string }): Promise<StartNativeCliAuthResponse> {
      await requireConfig();
      return { session: await host.startAuth(agentName) };
    },

    getAuth({ id }: { id: string }): GetNativeCliAuthSessionResponse {
      return { session: host.getAuth(id) };
    },

    subscribeAuth({ id, onSession }: { id: string; onSession: (session: NativeCliAuthSessionView) => void }): {
      session: NativeCliAuthSessionView;
      dispose: () => void;
    } {
      return host.subscribeAuth(id, onSession);
    },

    inputAuth({ id, input }: { id: string } & NativeCliInputRequest): OkResponse {
      host.inputAuth(id, { input });
      return { ok: true };
    },

    resizeAuth({ id, cols, rows }: { id: string } & NativeCliResizeRequest): OkResponse {
      host.resizeAuth(id, { cols, rows });
      return { ok: true };
    },

    heartbeatAuth({ id }: { id: string }): OkResponse {
      host.heartbeatAuth(id);
      return { ok: true };
    },

    stopAuth({ id }: { id: string }): OkResponse {
      host.stopAuth(id);
      return { ok: true };
    },

    async authStatus({ agentName }: { agentName: string }): Promise<NativeCliAuthStatusResponse> {
      await requireConfig();
      try {
        return await host.authStatus(agentName);
      } catch (error) {
        mapNativeCliError(error);
      }
    }
  };
}
