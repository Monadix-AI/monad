import type {
  Event,
  MeshAgentApprovalResolutionRequest,
  MeshAgentRuntimeCapabilities,
  MeshAgentTurnInput,
  MonadAppServerRequest,
  MonadAppServerResponse,
  NativeAgentManagedMcpServer,
  SessionId
} from '@monad/protocol';
import type {
  MeshAgentEventSink,
  ResidentProviderDriver,
  SessionEventChannel,
  SessionEventChannelContext,
  SessionEventPacket
} from '@monad/sdk-atom';

import {
  eventSchema,
  monadAppServerMessageSchema,
  monadAppServerRequestSchema,
  sessionMessageCompletedPayloadSchema,
  sessionMessageDeltaAppendedPayloadSchema,
  sessionRunFailedPayloadSchema,
  toolApprovalRequestedPayloadSchema,
  toolApprovalResolvedPayloadSchema,
  toolCalledPayloadSchema,
  toolProgressPayloadSchema,
  toolResultPayloadSchema
} from '@monad/protocol';

const CAPABILITIES: MeshAgentRuntimeCapabilities = {
  input: true,
  steer: true,
  interrupt: true,
  approvalResolution: true,
  providerSessionContinuation: true,
  runtimeRestoration: true,
  sessionReopen: true
};

interface PendingRequest {
  method: MonadAppServerRequest['method'];
  resolve(response: MonadAppServerResponse): void;
  reject(error: Error): void;
}

function frame(value: MonadAppServerRequest): string {
  return `${JSON.stringify(value)}\n`;
}

function mapEvent(eventInput: Event) {
  const event = eventSchema.parse(eventInput);
  switch (event.type) {
    case 'session.message.delta.appended': {
      const payload = sessionMessageDeltaAppendedPayloadSchema.parse(event.payload);
      if (payload.channel !== 'text') return [];
      return [{ type: 'agent_message' as const, payload: { text: payload.delta } }];
    }
    case 'session.message.completed': {
      const payload = sessionMessageCompletedPayloadSchema.parse(event.payload);
      if (payload.message.role !== 'assistant') return [];
      return [{ type: 'agent_message' as const, payload: { text: payload.message.text, final: true } }];
    }
    case 'tool.called': {
      const payload = toolCalledPayloadSchema.parse(event.payload);
      return [
        {
          type: 'tool_call' as const,
          payload: { callId: payload.toolCallId, tool: payload.tool, input: payload.input }
        }
      ];
    }
    case 'tool.progress': {
      const payload = toolProgressPayloadSchema.parse(event.payload);
      return [
        {
          type: 'tool_result' as const,
          payload: { callId: payload.toolCallId, tool: payload.tool, output: payload.output, status: 'running' }
        }
      ];
    }
    case 'tool.result': {
      const payload = toolResultPayloadSchema.parse(event.payload);
      return [
        {
          type: 'tool_result' as const,
          payload: {
            callId: payload.toolCallId,
            tool: payload.tool,
            output: payload.displayResult ?? payload.result,
            status: payload.ok ? 'completed' : 'failed'
          }
        }
      ];
    }
    case 'tool.approval_requested': {
      const payload = toolApprovalRequestedPayloadSchema.parse(event.payload);
      return [
        {
          type: 'approval_requested' as const,
          payload: {
            requestId: payload.requestId,
            kind: 'tool',
            tool: payload.tool,
            ...(payload.key ? { key: payload.key } : {}),
            input: payload.input
          }
        }
      ];
    }
    case 'tool.approval_resolved': {
      const payload = toolApprovalResolvedPayloadSchema.parse(event.payload);
      return [
        {
          type: 'approval_resolved' as const,
          payload: {
            requestId: payload.requestId,
            allow: payload.allow,
            ...(payload.reason ? { reason: payload.reason } : {})
          }
        }
      ];
    }
    case 'session.run.failed': {
      const payload = sessionRunFailedPayloadSchema.parse(event.payload);
      return [{ type: 'provider_error' as const, payload: payload.error }];
    }
    default:
      return [];
  }
}

export class MonadSessionEventDriver implements ResidentProviderDriver {
  readonly processModel = 'resident' as const;
  readonly controls = {
    approvalResolution: { resolve: (resolution) => this.resolveApproval(resolution) },
    steer: { send: (input) => this.sendControlTurn('turn/steer', input) },
    interrupt: { run: () => this.interrupt() }
  } as ResidentProviderDriver['controls'];
  private channel?: SessionEventChannel;
  private decoder = new TextDecoder();
  private stderrDecoder = new TextDecoder();
  private pendingText = '';
  private stderrText = '';
  private requestSequence = 0;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private sessionId?: SessionId;
  private openPromise?: Promise<SessionId>;

  constructor(
    private readonly agentId: string,
    private readonly workingPath: string,
    private readonly providerSessionRef?: string,
    private readonly managedMcpServer?: NativeAgentManagedMcpServer,
    private readonly immutableInstructions?: string
  ) {}

  async openSession() {
    return {
      capabilities: CAPABILITIES,
      ...(this.providerSessionRef ? { providerSessionRef: this.providerSessionRef } : {})
    };
  }

  async attachChannel(channel: SessionEventChannel, context: SessionEventChannelContext) {
    this.channel = channel;
    this.openPromise = this.request('initialize', { protocolVersion: 1 })
      .then(() =>
        this.request('session/open', {
          agentId: this.agentId,
          cwd: this.workingPath,
          ...(context.providerSessionRef ? { providerSessionRef: context.providerSessionRef } : {}),
          ...(this.immutableInstructions ? { immutableInstructions: this.immutableInstructions } : {}),
          ...(this.managedMcpServer ? { mcpServers: [this.managedMcpServer] } : {})
        })
      )
      .then((response) => {
        if (!('result' in response) || response.method !== 'session/open') {
          throw new Error('Monad app-server returned an invalid session/open response');
        }
        this.sessionId = response.result.sessionId;
        return this.sessionId;
      });
    await this.openPromise;
    return undefined;
  }

  async sendTurn(input: MeshAgentTurnInput): Promise<void> {
    await this.sendControlTurn('turn/start', input);
  }

  async accept(packet: SessionEventPacket, sink: MeshAgentEventSink): Promise<void> {
    if (packet.source === 'stderr') {
      this.stderrText = `${this.stderrText}${this.stderrDecoder.decode(packet.bytes, { stream: true })}`.slice(-8_192);
      return;
    }
    this.pendingText += this.decoder.decode(packet.bytes, { stream: true });
    const boundary = this.pendingText.lastIndexOf('\n');
    if (boundary < 0) return;
    const complete = this.pendingText.slice(0, boundary);
    this.pendingText = this.pendingText.slice(boundary + 1);
    for (const line of complete.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const message = monadAppServerMessageSchema.parse(JSON.parse(line));
      if (message.kind === 'response') {
        const pending = this.pendingRequests.get(message.id);
        if (!pending) continue;
        this.pendingRequests.delete(message.id);
        if (pending.method !== message.method) {
          pending.reject(new Error(`Monad app-server response method mismatch: ${message.method}`));
        } else if ('error' in message) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message);
        }
        continue;
      }
      if (message.kind === 'request') throw new Error('Monad app-server sent an unexpected request');
      if (message.method === 'session/identified') {
        this.sessionId = message.params.sessionId;
        await sink.emit({
          type: 'provider_session_identified',
          payload: { providerSessionRef: message.params.sessionId }
        });
        continue;
      }
      if (message.method === 'session/error') {
        await sink.emit({ type: 'provider_error', payload: message.params });
        continue;
      }
      for (const event of mapEvent(message.params.event)) await sink.emit(event);
    }
  }

  async dispose(): Promise<void> {
    if (this.channel && this.sessionId) {
      const request = monadAppServerRequestSchema.parse({
        kind: 'request',
        id: String(++this.requestSequence),
        method: 'session/close',
        params: { sessionId: this.sessionId }
      });
      await this.channel.send(frame(request)).catch(() => undefined);
    }
    const diagnostic = this.stderrText.trim();
    const closed = new Error(diagnostic ? `Monad app-server closed: ${diagnostic}` : 'Monad app-server closed');
    for (const pending of this.pendingRequests.values()) pending.reject(closed);
    this.pendingRequests.clear();
    await this.channel?.close();
    this.channel = undefined;
    this.openPromise = undefined;
    this.sessionId = undefined;
    this.pendingText = '';
    this.stderrText = '';
    this.decoder = new TextDecoder();
    this.stderrDecoder = new TextDecoder();
  }

  private async request(method: MonadAppServerRequest['method'], params: unknown): Promise<MonadAppServerResponse> {
    if (!this.channel) throw new Error('Monad app-server channel is not attached');
    const id = String(++this.requestSequence);
    const request = monadAppServerRequestSchema.parse({ kind: 'request', id, method, params });
    const response = new Promise<MonadAppServerResponse>((resolve, reject) => {
      this.pendingRequests.set(id, { method, resolve, reject });
    });
    try {
      await this.channel.send(frame(request));
    } catch (error) {
      this.pendingRequests.delete(id);
      throw error;
    }
    return response;
  }

  private async requireSessionId(): Promise<SessionId> {
    if (this.sessionId) return this.sessionId;
    if (!this.openPromise) throw new Error('Monad app-server session is not opening');
    return this.openPromise;
  }

  private async sendControlTurn(method: 'turn/start' | 'turn/steer', input: MeshAgentTurnInput): Promise<void> {
    const sessionId = await this.requireSessionId();
    await this.request(method, { sessionId, input });
  }

  private async interrupt(): Promise<void> {
    const sessionId = await this.requireSessionId();
    await this.request('turn/interrupt', { sessionId });
  }

  private async resolveApproval(resolution: MeshAgentApprovalResolutionRequest): Promise<void> {
    const sessionId = await this.requireSessionId();
    await this.request('approval/resolve', { sessionId, ...resolution });
  }
}
