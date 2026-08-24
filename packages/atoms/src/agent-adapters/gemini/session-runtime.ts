import type {
  MeshAgentApprovalResolutionRequest,
  MeshAgentRuntimeCapabilities,
  MeshAgentTurnInput,
  NativeAgentManagedMcpServer
} from '@monad/protocol';
import type {
  MeshAgentEventSink,
  ResidentProviderDriver,
  SessionEventChannel,
  SessionEventChannelContext,
  SessionEventPacket
} from '@monad/sdk-atom';
import type { JsonRpcId, JsonRpcResponse, PermissionRequest, SessionUpdate } from './acp-wire.ts';

import {
  genericRequestSchema,
  initializeResultSchema,
  jsonRpcResponseSchema,
  newSessionResultSchema,
  permissionRequestSchema,
  sessionUpdateNotificationSchema
} from './acp-wire.ts';

const REQUEST_TIMEOUT_MS = 20_000;

type PendingRequest = {
  method: string;
  reject(error: Error): void;
  resolve(value: unknown): void;
  timeout?: ReturnType<typeof setTimeout>;
};

const CAPABILITIES: MeshAgentRuntimeCapabilities = {
  input: true,
  steer: false,
  interrupt: true,
  approvalResolution: true,
  providerSessionContinuation: true,
  runtimeRestoration: true,
  sessionReopen: true
};

function turnText(input: MeshAgentTurnInput): string {
  if (input.attachments.length === 0) return input.text;
  const references = input.attachments.map((attachment) => `- ${attachment.name}: ${attachment.path}`).join('\n');
  return `${input.text}\n\nAttachments available in the workspace:\n${references}`;
}

function mcpServers(server: NativeAgentManagedMcpServer | undefined): Record<string, unknown>[] {
  if (!server) return [];
  return [
    {
      name: server.name,
      command: server.command,
      args: server.args,
      env: Object.entries(server.env).map(([name, value]) => ({ name, value }))
    }
  ];
}

function outputText(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const text = value
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return '';
      const content = (entry as Record<string, unknown>).content;
      if (!content || typeof content !== 'object' || Array.isArray(content)) return '';
      return typeof (content as Record<string, unknown>).text === 'string'
        ? (content as Record<string, unknown>).text
        : '';
    })
    .join('');
  return text || value;
}

export interface GeminiAcpSessionDriverOptions {
  additionalDirectories?: readonly string[];
  managedMcpServer?: NativeAgentManagedMcpServer;
  providerSessionRef?: string;
  workingPath: string;
}

export class GeminiAcpSessionDriver implements ResidentProviderDriver {
  readonly processModel = 'resident' as const;
  readonly controls = {
    approvalResolution: {
      resolve: (resolution: MeshAgentApprovalResolutionRequest) => this.resolveApproval(resolution)
    },
    steer: false,
    interrupt: { run: () => this.interrupt() }
  } as const;

  private activePromptId?: JsonRpcId;
  private channel?: SessionEventChannel;
  private decoder = new TextDecoder();
  private nextRequestId = 0;
  private pending = '';
  private readonly pendingRequests = new Map<JsonRpcId, PendingRequest>();
  private readonly permissionRequests = new Map<string, PermissionRequest>();
  private sessionId?: string;
  private sessionReady: Promise<string> = Promise.reject(new Error('Gemini ACP channel is not attached'));
  private turnText = '';

  constructor(private readonly options: GeminiAcpSessionDriverOptions) {
    void this.sessionReady.catch(() => {});
  }

  async openSession() {
    return { capabilities: CAPABILITIES };
  }

  async attachChannel(channel: SessionEventChannel, context: SessionEventChannelContext): Promise<undefined> {
    this.rejectPending(new Error('Gemini ACP control channel changed'));
    this.channel = channel;
    this.decoder = new TextDecoder();
    this.pending = '';
    this.sessionId = context.providerSessionRef ?? this.options.providerSessionRef;
    this.turnText = '';
    this.sessionReady = this.initializeSession();
    void this.sessionReady.catch(() => {});
    return undefined;
  }

  async sendTurn(input: MeshAgentTurnInput): Promise<void> {
    const sessionId = await this.sessionReady;
    this.turnText = '';
    const id = ++this.nextRequestId;
    this.activePromptId = id;
    try {
      await this.send({
        jsonrpc: '2.0',
        id,
        method: 'session/prompt',
        params: {
          sessionId,
          prompt: [{ type: 'text', text: turnText(input) }]
        }
      });
    } catch (error) {
      if (this.activePromptId === id) this.activePromptId = undefined;
      throw error;
    }
  }

  async accept(packet: SessionEventPacket, sink: MeshAgentEventSink): Promise<void> {
    if (packet.source === 'stderr') return;
    this.pending += this.decoder.decode(packet.bytes, { stream: true });
    const boundary = this.pending.lastIndexOf('\n');
    if (boundary < 0) return;
    const complete = this.pending.slice(0, boundary + 1);
    this.pending = this.pending.slice(boundary + 1);
    for (const rawLine of complete.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith('{')) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const response = jsonRpcResponseSchema.safeParse(value);
      if (response.success) {
        await this.consumeResponse(response.data, sink);
        continue;
      }
      const update = sessionUpdateNotificationSchema.safeParse(value);
      if (update.success) {
        await this.consumeUpdate(update.data.params, sink);
        continue;
      }
      const permission = permissionRequestSchema.safeParse(value);
      if (permission.success) {
        await this.consumePermissionRequest(permission.data, sink);
        continue;
      }
      const request = genericRequestSchema.safeParse(value);
      if (request.success) {
        await this.send({
          jsonrpc: '2.0',
          id: request.data.id,
          error: { code: -32601, message: `Unsupported Gemini ACP request: ${request.data.method}` }
        });
      }
    }
  }

  async dispose(): Promise<void> {
    this.rejectPending(new Error('Gemini ACP session runtime closed'));
    this.permissionRequests.clear();
    this.decoder = new TextDecoder();
    this.pending = '';
    this.sessionId = undefined;
    this.activePromptId = undefined;
    this.turnText = '';
    await this.channel?.close();
    this.channel = undefined;
  }

  private async initializeSession(): Promise<string> {
    const initialized = initializeResultSchema.parse(
      await this.request(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'monad', version: '0.0.1' }
        },
        REQUEST_TIMEOUT_MS
      )
    );
    const setup = {
      cwd: this.options.workingPath,
      additionalDirectories: [...(this.options.additionalDirectories ?? [])],
      mcpServers: mcpServers(this.options.managedMcpServer)
    };
    const resume = this.sessionId;
    if (resume) {
      if (initialized.agentCapabilities?.loadSession === false) {
        throw new Error('Gemini ACP runtime does not support session/load');
      }
      await this.request('session/load', { ...setup, sessionId: resume }, REQUEST_TIMEOUT_MS);
      return resume;
    }
    const created = newSessionResultSchema.parse(await this.request('session/new', setup, REQUEST_TIMEOUT_MS));
    this.sessionId = created.sessionId;
    return created.sessionId;
  }

  private async interrupt(): Promise<void> {
    const sessionId = await this.sessionReady;
    await this.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
  }

  private async resolveApproval(resolution: MeshAgentApprovalResolutionRequest): Promise<void> {
    const request = this.permissionRequests.get(resolution.requestId);
    if (!request) throw new Error(`Unknown Gemini ACP permission request: ${resolution.requestId}`);
    const kinds = resolution.allow
      ? new Set(['allow_once', 'allow_always'])
      : new Set(['reject_once', 'reject_always']);
    const option = request.params.options.find((candidate) => kinds.has(candidate.kind));
    await this.send({
      jsonrpc: '2.0',
      id: request.id,
      result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } }
    });
    this.permissionRequests.delete(resolution.requestId);
  }

  private async consumeResponse(response: JsonRpcResponse, sink: MeshAgentEventSink): Promise<void> {
    const pending = this.pendingRequests.get(response.id);
    if (pending) {
      this.pendingRequests.delete(response.id);
      if (pending.timeout) clearTimeout(pending.timeout);
      if (response.error) {
        pending.reject(new Error(`Gemini ACP ${pending.method} failed: ${response.error.message}`));
      } else {
        if (pending.method === 'session/new') {
          const created = newSessionResultSchema.parse(response.result);
          this.sessionId = created.sessionId;
          await sink.emit({
            type: 'provider_session_identified',
            payload: { providerSessionRef: created.sessionId }
          });
        }
        pending.resolve(response.result);
      }
      return;
    }
    if (response.id !== this.activePromptId) return;
    this.activePromptId = undefined;
    if (response.error) {
      this.turnText = '';
      await sink.emit({
        type: 'provider_error',
        payload: { code: response.error.code, message: response.error.message, responseId: response.id }
      });
      return;
    }
    const text = this.turnText;
    this.turnText = '';
    await sink.emit({ type: 'agent_message', payload: { text, final: true } });
  }

  private async consumeUpdate(notification: SessionUpdate, sink: MeshAgentEventSink): Promise<void> {
    if (notification.sessionId !== this.sessionId) return;
    const update = notification.update;
    if (
      update.sessionUpdate === 'agent_message_chunk' &&
      !Array.isArray(update.content) &&
      update.content?.type === 'text' &&
      update.content.text
    ) {
      this.turnText += update.content.text;
      await sink.emit({ type: 'agent_message', payload: { text: update.content.text } });
      return;
    }
    if (update.sessionUpdate === 'tool_call') {
      await sink.emit({
        type: 'tool_call',
        payload: {
          callId: update.toolCallId,
          tool: update.name ?? update.title,
          input: update.rawInput
        }
      });
      return;
    }
    if (update.sessionUpdate === 'tool_call_update' && (update.status === 'completed' || update.status === 'failed')) {
      await sink.emit({
        type: 'tool_result',
        payload: { callId: update.toolCallId, output: outputText(update.rawOutput ?? update.content) }
      });
    }
  }

  private async consumePermissionRequest(request: PermissionRequest, sink: MeshAgentEventSink): Promise<void> {
    if (request.params.sessionId !== this.sessionId) {
      await this.send({ jsonrpc: '2.0', id: request.id, result: { outcome: { outcome: 'cancelled' } } });
      return;
    }
    const requestId = String(request.id);
    this.permissionRequests.set(requestId, request);
    await sink.emit({
      type: 'approval_requested',
      payload: {
        requestId,
        kind: 'can_use_tool',
        callId: request.params.toolCall.toolCallId,
        tool: request.params.toolCall.name ?? request.params.toolCall.title ?? 'tool',
        input: request.params.toolCall.rawInput,
        options: request.params.options
      }
    });
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const id = ++this.nextRequestId;
    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = timeoutMs
        ? setTimeout(() => {
            this.pendingRequests.delete(id);
            reject(new Error(`Gemini ACP request timed out: ${method}`));
          }, timeoutMs)
        : undefined;
      this.pendingRequests.set(id, { method, resolve, reject, ...(timeout ? { timeout } : {}) });
    });
    void this.send({ jsonrpc: '2.0', id, method, params }).catch((error) => {
      const pending = this.pendingRequests.get(id);
      if (!pending) return;
      this.pendingRequests.delete(id);
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    });
    return result;
  }

  private send(value: Record<string, unknown>): Promise<void> {
    if (!this.channel) return Promise.reject(new Error('Gemini ACP session channel is unavailable'));
    return this.channel.send(`${JSON.stringify(value)}\n`);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      this.pendingRequests.delete(id);
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }
}
