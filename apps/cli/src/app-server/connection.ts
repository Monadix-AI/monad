import type {
  AgentId,
  ClarifyRespondRequest,
  ClarifyRespondResponse,
  Event,
  EventId,
  MeshAgentTurnInput,
  MonadAppServerNotification,
  MonadAppServerRequest,
  MonadAppServerResponse,
  NativeAgentManagedMcpServer,
  SessionId,
  ToolApproveRequest,
  ToolApproveResponse
} from '@monad/protocol';

import {
  monadAppServerNotificationSchema,
  monadAppServerRequestSchema,
  monadAppServerResponseSchema
} from '@monad/protocol';

interface MonadEventStreamError {
  kind: 'fatal' | 'transient';
  cause?: unknown;
  status?: number;
}

export interface MonadAppServerClient {
  openSession(input: {
    agentId: AgentId;
    cwd: string;
    providerSessionRef?: SessionId;
    immutableInstructions?: string;
    mcpServers?: NativeAgentManagedMcpServer[];
  }): Promise<SessionId>;
  subscribeEvents(
    sessionId: SessionId,
    afterEventId: EventId | undefined,
    onEvent: (event: Event) => void,
    onError: (error: MonadEventStreamError) => void
  ): () => void;
  sendTurn(sessionId: SessionId, input: MeshAgentTurnInput, steer: boolean): Promise<{ accepted: true }>;
  interrupt(sessionId: SessionId): Promise<{ ok: boolean }>;
  resolveApproval(input: ToolApproveRequest): Promise<ToolApproveResponse>;
  respondClarify(input: ClarifyRespondRequest): Promise<ClarifyRespondResponse>;
}

type AppServerOutput = MonadAppServerNotification | MonadAppServerResponse;

interface MonadAppServerConnectionOptions {
  client: MonadAppServerClient;
  write(message: AppServerOutput): void;
}

const CAPABILITIES = {
  input: true,
  steer: true,
  interrupt: true,
  approvalResolution: true,
  providerSessionContinuation: true,
  runtimeRestoration: true,
  sessionReopen: true
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createMonadAppServerConnection({ client, write }: MonadAppServerConnectionOptions): {
  handleLine(line: string): Promise<void>;
  close(): Promise<void>;
} {
  let activeSessionId: SessionId | undefined;
  let disposeEvents: (() => void) | undefined;

  const writeResponse = (message: unknown): void => {
    write(monadAppServerResponseSchema.parse(message));
  };
  const writeNotification = (message: unknown): void => {
    write(monadAppServerNotificationSchema.parse(message));
  };
  const closeStream = (): void => {
    disposeEvents?.();
    disposeEvents = undefined;
    activeSessionId = undefined;
  };
  const requireActiveSession = (sessionId: SessionId): void => {
    if (sessionId !== activeSessionId) throw new Error(`Monad session is not open: ${sessionId}`);
  };
  const reply = (request: MonadAppServerRequest, result: unknown): void => {
    writeResponse({ kind: 'response', id: request.id, method: request.method, result });
  };
  const replyError = (request: MonadAppServerRequest, error: unknown): void => {
    writeResponse({
      kind: 'response',
      id: request.id,
      method: request.method,
      error: {
        code: errorMessage(error).startsWith('Monad session is not open:') ? 'session_not_open' : 'request_failed',
        message: errorMessage(error),
        retryable: false
      }
    });
  };

  const handle = async (request: MonadAppServerRequest): Promise<void> => {
    switch (request.method) {
      case 'initialize':
        reply(request, { protocolVersion: 1, capabilities: CAPABILITIES });
        return;
      case 'session/open': {
        closeStream();
        const sessionId = await client.openSession({
          agentId: request.params.agentId,
          cwd: request.params.cwd,
          ...(request.params.providerSessionRef ? { providerSessionRef: request.params.providerSessionRef } : {}),
          ...(request.params.immutableInstructions
            ? { immutableInstructions: request.params.immutableInstructions }
            : {}),
          ...(request.params.mcpServers ? { mcpServers: request.params.mcpServers } : {})
        });
        activeSessionId = sessionId;
        reply(request, { sessionId });
        writeNotification({ kind: 'notification', method: 'session/identified', params: { sessionId } });
        disposeEvents = client.subscribeEvents(
          sessionId,
          request.params.afterEventId,
          (event) => {
            writeNotification({ kind: 'notification', method: 'session/event', params: { event } });
          },
          (error) => {
            const detail = error.status ? ` (${error.status})` : '';
            writeNotification({
              kind: 'notification',
              method: 'session/error',
              params: {
                code: 'stream_disconnected',
                message: `Monad event stream disconnected${detail}`,
                retryable: error.kind === 'transient'
              }
            });
          }
        );
        return;
      }
      case 'turn/start':
        requireActiveSession(request.params.sessionId);
        reply(request, await client.sendTurn(request.params.sessionId, request.params.input, false));
        return;
      case 'turn/steer':
        requireActiveSession(request.params.sessionId);
        reply(request, await client.sendTurn(request.params.sessionId, request.params.input, true));
        return;
      case 'turn/interrupt':
        requireActiveSession(request.params.sessionId);
        reply(request, await client.interrupt(request.params.sessionId));
        return;
      case 'approval/resolve': {
        requireActiveSession(request.params.sessionId);
        const { sessionId: _sessionId, ...input } = request.params;
        reply(request, await client.resolveApproval(input));
        return;
      }
      case 'clarify/respond': {
        requireActiveSession(request.params.sessionId);
        const { sessionId: _sessionId, ...input } = request.params;
        reply(request, await client.respondClarify(input));
        return;
      }
      case 'session/close':
        requireActiveSession(request.params.sessionId);
        closeStream();
        reply(request, { ok: true });
    }
  };

  return {
    async handleLine(line): Promise<void> {
      let request: MonadAppServerRequest;
      try {
        request = monadAppServerRequestSchema.parse(JSON.parse(line));
      } catch (error) {
        writeNotification({
          kind: 'notification',
          method: 'session/error',
          params: { code: 'invalid_request', message: errorMessage(error), retryable: false }
        });
        return;
      }
      try {
        await handle(request);
      } catch (error) {
        replyError(request, error);
      }
    },
    async close(): Promise<void> {
      closeStream();
    }
  };
}
