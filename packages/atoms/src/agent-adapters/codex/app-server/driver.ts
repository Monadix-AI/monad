import type {
  MeshAgentApprovalResolutionRequest,
  MeshAgentRuntimeCapabilities,
  MeshAgentTurnInput
} from '@monad/protocol';
import type {
  MeshAgentEventSink,
  MeshAgentSessionRuntimeContext,
  ResidentProviderDriver,
  SessionEventChannel,
  SessionEventChannelContext,
  SessionEventPacket
} from '@monad/sdk-atom';
import type { CodexAppServerEventContext } from './events.ts';

import { jsonRpcNotification, jsonRpcRequest, jsonRpcResponse, jsonRpcResponseId } from '../../jsonrpc.ts';
import { parseCodexSessionJsonl, recordValue } from './events.ts';
import { codexRuntimeState } from './state.ts';

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
  method: string;
  resolve(result: Record<string, unknown>): void;
  reject(error: Error): void;
}

class CodexAppServerRequestError extends Error {
  constructor(
    readonly code: unknown,
    message: string
  ) {
    super(message);
  }
}

function turnText(input: MeshAgentTurnInput): string {
  if (input.attachments.length === 0) return input.text;
  const references = input.attachments.map((attachment) => `- ${attachment.name}: ${attachment.path}`).join('\n');
  return `${input.text}\n\nAttachments available in the workspace:\n${references}`;
}

function threadIdFromResult(result: Record<string, unknown>): string | undefined {
  const thread = recordValue(result.thread);
  return typeof thread?.id === 'string' ? thread.id : undefined;
}

function turnIdFromResult(result: Record<string, unknown>): string | undefined {
  if (typeof result.turnId === 'string') return result.turnId;
  const turn = recordValue(result.turn);
  return typeof turn?.id === 'string' ? turn.id : undefined;
}

function isApprovalRequest(method: string): boolean {
  return (
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval' ||
    method === 'item/permissions/requestApproval' ||
    method === 'execCommandApproval' ||
    method === 'applyPatchApproval'
  );
}

function approvalResult(request: Record<string, unknown> | undefined, allow: boolean): Record<string, unknown> {
  const method = typeof request?.method === 'string' ? request.method : '';
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    return { decision: allow ? 'approved' : 'denied' };
  }
  if (method === 'item/permissions/requestApproval') {
    return allow ? { permissions: {}, scope: 'turn' } : { permissions: {}, scope: 'turn', strictAutoReview: true };
  }
  return { decision: allow ? 'accept' : 'decline' };
}

function isSteerRace(error: unknown): boolean {
  if (!(error instanceof CodexAppServerRequestError)) return false;
  return /active turn|expected.*turn|turn.*active|no active turn/i.test(error.message);
}

export class CodexAppServerDriver implements ResidentProviderDriver {
  readonly processModel = 'resident' as const;
  readonly controls = {
    approvalResolution: { resolve: (resolution) => this.resolveApproval(resolution) },
    steer: { send: (input) => this.enqueueInput(input, true) },
    interrupt: { run: () => this.interrupt() }
  } as ResidentProviderDriver['controls'];
  private channel?: SessionEventChannel;
  private decoder = new TextDecoder();
  private pendingText = '';
  private requestSequence = 0;
  private inputSequence = 0;
  private inputTail: Promise<void> = Promise.resolve();
  private openPromise?: Promise<string>;
  private threadId?: string;
  private readonly pendingRequests = new Map<string | number, PendingRequest>();
  private readonly approvalRequests = new Map<string, Record<string, unknown>>();
  private readonly handle: CodexAppServerEventContext;

  constructor(private readonly context: MeshAgentSessionRuntimeContext) {
    this.threadId = context.providerSessionRef;
    this.handle = {
      providerSessionRef: context.providerSessionRef ?? null,
      nextRequestId: () => ++this.requestSequence,
      pendingRequests: new Map()
    };
  }

  async openSession() {
    return {
      capabilities: CAPABILITIES,
      ...(this.threadId ? { providerSessionRef: this.threadId } : {})
    };
  }

  async attachChannel(channel: SessionEventChannel, context: SessionEventChannelContext) {
    this.rejectPending(new Error('Codex app-server channel was replaced'));
    this.channel = channel;
    this.decoder = new TextDecoder();
    this.pendingText = '';
    this.handle.appServer = {
      send: (frame) => {
        void this.channel?.send(frame);
      },
      close: () => {
        void this.channel?.close();
      }
    };
    this.handle.providerSessionRef = context.providerSessionRef ?? this.threadId ?? null;
    this.openPromise = this.openThread(context.providerSessionRef ?? this.threadId);
    await this.openPromise;
    return undefined;
  }

  sendTurn(input: MeshAgentTurnInput): Promise<void> {
    return this.enqueueInput(input, false);
  }

  async accept(packet: SessionEventPacket, sink: MeshAgentEventSink): Promise<void> {
    if (packet.source === 'stderr') return;
    this.pendingText += this.decoder.decode(packet.bytes, { stream: true });
    const boundary = this.pendingText.lastIndexOf('\n');
    if (boundary < 0) return;
    const complete = this.pendingText.slice(0, boundary);
    this.pendingText = this.pendingText.slice(boundary + 1);
    for (const line of complete.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      const id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : undefined;
      if (id !== undefined && ('result' in message || 'error' in message) && typeof message.method !== 'string') {
        await this.acceptResponse(id, message, sink);
        continue;
      }
      const method = typeof message.method === 'string' ? message.method : undefined;
      if (method && id !== undefined && isApprovalRequest(method)) {
        this.approvalRequests.set(String(id), message);
      }
      for (const event of parseCodexSessionJsonl(`${line}\n`, this.handle)) await sink.emit(event);
    }
  }

  async dispose(): Promise<void> {
    this.rejectPending(new Error('Codex app-server closed'));
    this.approvalRequests.clear();
    this.pendingText = '';
    this.decoder = new TextDecoder();
    codexRuntimeState(this.handle).currentTurnId = undefined;
    await this.channel?.close();
    this.channel = undefined;
    this.handle.appServer = undefined;
    this.openPromise = undefined;
  }

  private enqueueInput(input: MeshAgentTurnInput, requireActiveTurn: boolean): Promise<void> {
    const job = this.inputTail.then(() => this.deliverInput(input, requireActiveTurn));
    this.inputTail = job.catch(() => undefined);
    return job;
  }

  private async deliverInput(input: MeshAgentTurnInput, requireActiveTurn: boolean): Promise<void> {
    const threadId = await this.requireThreadId();
    const state = codexRuntimeState(this.handle);
    const expectedTurnId = state.currentTurnId;
    const clientUserMessageId = `monad-${++this.inputSequence}`;
    const userInput = [{ type: 'text', text: turnText(input), text_elements: [] }];
    if (!expectedTurnId) {
      if (requireActiveTurn) throw new Error('Codex app-server has no active turn to steer');
      await this.startTurn(threadId, clientUserMessageId, userInput);
      return;
    }
    try {
      const result = await this.request(
        'turn/steer',
        { threadId, expectedTurnId, clientUserMessageId, input: userInput },
        'turn'
      );
      state.currentTurnId = turnIdFromResult(result) ?? expectedTurnId;
    } catch (error) {
      if (requireActiveTurn || !isSteerRace(error)) throw error;
      state.currentTurnId = undefined;
      await this.startTurn(threadId, clientUserMessageId, userInput);
    }
  }

  private async startTurn(
    threadId: string,
    clientUserMessageId: string,
    input: Array<Record<string, unknown>>
  ): Promise<void> {
    const result = await this.request(
      'turn/start',
      {
        threadId,
        clientUserMessageId,
        input,
        ...((this.context.modelId ?? this.context.modelName)
          ? { model: this.context.modelId ?? this.context.modelName }
          : {}),
        ...(this.context.reasoningEffort ? { effort: this.context.reasoningEffort } : {})
      },
      'turn'
    );
    const turnId = turnIdFromResult(result);
    if (!turnId) throw new Error('Codex app-server returned turn/start without a turn id');
    codexRuntimeState(this.handle).currentTurnId = turnId;
  }

  private async openThread(providerSessionRef?: string): Promise<string> {
    await this.request(
      'initialize',
      {
        clientInfo: { name: 'monad', title: 'Monad', version: '0.0.1' },
        capabilities: { experimentalApi: true, requestAttestation: false }
      },
      'initialize'
    );
    await this.send(jsonRpcNotification('initialized'));
    const immutableInstructions = this.context.startInput?.immutableInstructions?.text;
    const result = providerSessionRef
      ? await this.request(
          'thread/resume',
          {
            threadId: providerSessionRef,
            cwd: this.context.workingPath,
            ...((this.context.modelId ?? this.context.modelName)
              ? { model: this.context.modelId ?? this.context.modelName }
              : {}),
            ...(immutableInstructions ? { developerInstructions: immutableInstructions } : {})
          },
          'threadResume'
        )
      : await this.request(
          'thread/start',
          {
            cwd: this.context.workingPath,
            ...((this.context.modelId ?? this.context.modelName)
              ? { model: this.context.modelId ?? this.context.modelName }
              : {}),
            ...(immutableInstructions ? { developerInstructions: immutableInstructions } : {})
          },
          'thread'
        );
    const threadId = threadIdFromResult(result);
    if (!threadId) throw new Error('Codex app-server returned no thread id');
    this.threadId = threadId;
    this.handle.providerSessionRef = threadId;
    return threadId;
  }

  private async acceptResponse(
    id: string | number,
    message: Record<string, unknown>,
    sink: MeshAgentEventSink
  ): Promise<void> {
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
    this.pendingRequests.delete(id);
    this.handle.pendingRequests?.delete(id);
    const error = recordValue(message.error);
    if (error) {
      pending.reject(
        new CodexAppServerRequestError(
          error.code,
          typeof error.message === 'string' ? error.message : JSON.stringify(error)
        )
      );
      return;
    }
    const result = recordValue(message.result) ?? {};
    const providerSessionRef =
      pending.method === 'thread/start' || pending.method === 'thread/resume' ? threadIdFromResult(result) : undefined;
    if (providerSessionRef) {
      this.threadId = providerSessionRef;
      this.handle.providerSessionRef = providerSessionRef;
      await sink.emit({ type: 'provider_session_identified', payload: { providerSessionRef } });
    }
    pending.resolve(result);
  }

  private request(method: string, params: Record<string, unknown>, kind: string): Promise<Record<string, unknown>> {
    const id = ++this.requestSequence;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pendingRequests.set(id, { method, resolve, reject });
      this.handle.pendingRequests?.set(id, kind);
    });
    return this.send(jsonRpcRequest(method, id, params)).then(() => response);
  }

  private async requireThreadId(): Promise<string> {
    if (this.threadId && !this.openPromise) return this.threadId;
    if (!this.openPromise) throw new Error('Codex app-server thread is not opening');
    return this.openPromise;
  }

  private async interrupt(): Promise<void> {
    const threadId = await this.requireThreadId();
    const turnId = codexRuntimeState(this.handle).currentTurnId;
    if (!turnId) return;
    await this.request('turn/interrupt', { threadId, turnId }, 'interrupt');
  }

  private async resolveApproval(resolution: MeshAgentApprovalResolutionRequest): Promise<void> {
    if (!this.channel) throw new Error('Codex app-server channel is not attached');
    const request = this.approvalRequests.get(resolution.requestId);
    await this.send(
      jsonRpcResponse(jsonRpcResponseId(request?.id, resolution.requestId), approvalResult(request, resolution.allow))
    );
    this.approvalRequests.delete(resolution.requestId);
  }

  private async send(frame: string): Promise<void> {
    if (!this.channel) throw new Error('Codex app-server channel is not attached');
    await this.channel.send(frame);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) pending.reject(error);
    this.pendingRequests.clear();
    this.handle.pendingRequests?.clear();
  }
}
