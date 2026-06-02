import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { MeshAgentTurnInput } from '@monad/protocol';
import type {
  MeshAgentEventSink,
  MeshAgentOutputEvent,
  MeshAgentSessionEvent,
  ResidentProviderDriver,
  SessionEventChannel,
  SessionEventChannelContext,
  SessionEventPacket
} from '@monad/sdk-atom';

import { randomUUID } from 'node:crypto';

const CONTROL_TIMEOUT_MS = 10_000;

type PendingControl = {
  reject(error: Error): void;
  resolve(response: Record<string, unknown>): void;
  timeout: ReturnType<typeof setTimeout>;
};

type ClaudeCodeSessionDriverOptions = {
  parseOutput(chunk: string): MeshAgentOutputEvent[];
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function turnText(input: MeshAgentTurnInput): string {
  if (input.attachments.length === 0) return input.text;
  const references = input.attachments.map((attachment) => `- ${attachment.name}: ${attachment.path}`).join('\n');
  return `${input.text}\n\nAttachments available in the workspace:\n${references}`;
}

function userMessage(input: MeshAgentTurnInput): SDKUserMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'text', text: turnText(input) }]
    }
  };
}

export class ClaudeCodeSessionDriver implements ResidentProviderDriver {
  readonly processModel = 'resident' as const;
  readonly controls = {
    approvalResolution: false,
    steer: { send: (input: MeshAgentTurnInput) => this.sendInput(input) },
    interrupt: { run: () => this.interrupt() }
  } as const;

  private channel?: SessionEventChannel;
  private controlSequence = 0;
  private readonly pendingControls = new Map<string, PendingControl>();
  private readonly decoders = {
    'provider-channel': new TextDecoder(),
    stdout: new TextDecoder()
  };
  private readonly pending = {
    'provider-channel': '',
    stdout: ''
  };

  constructor(private readonly options: ClaudeCodeSessionDriverOptions) {}

  async openSession() {
    return {
      capabilities: {
        input: true,
        steer: true,
        interrupt: true,
        approvalResolution: false,
        providerSessionContinuation: true,
        runtimeRestoration: true,
        sessionReopen: true
      }
    };
  }

  async attachChannel(channel: SessionEventChannel, _context: SessionEventChannelContext): Promise<undefined> {
    this.rejectPending(new Error('Claude Code control channel changed'));
    this.channel = channel;
    this.resetDecoders();
    return undefined;
  }

  sendTurn(input: MeshAgentTurnInput): Promise<void> {
    return this.sendInput(input);
  }

  async accept(packet: SessionEventPacket, sink: MeshAgentEventSink): Promise<void> {
    if (packet.source === 'stderr') return;
    const source = packet.source;
    this.pending[source] += this.decoders[source].decode(packet.bytes, { stream: true });
    const boundary = this.pending[source].lastIndexOf('\n');
    if (boundary < 0) return;
    const complete = this.pending[source].slice(0, boundary + 1);
    this.pending[source] = this.pending[source].slice(boundary + 1);
    for (const rawLine of complete.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (this.consumeControlResponse(line)) continue;
      await this.emitOutput(line, sink);
    }
  }

  async dispose(): Promise<void> {
    this.rejectPending(new Error('Claude Code session runtime closed'));
    this.resetDecoders();
    await this.channel?.close();
    this.channel = undefined;
  }

  private async sendInput(input: MeshAgentTurnInput): Promise<void> {
    if (!this.channel) throw new Error('Claude Code session channel is unavailable');
    await this.channel.send(`${JSON.stringify(userMessage(input))}\n`);
  }

  private async interrupt(): Promise<void> {
    await this.sendControl({ subtype: 'interrupt' });
  }

  private sendControl(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.channel) return Promise.reject(new Error('Claude Code session channel is unavailable'));
    const requestId = `monad-${++this.controlSequence}-${randomUUID()}`;
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingControls.delete(requestId);
        reject(new Error(`Claude Code control request timed out: ${String(request.subtype)}`));
      }, CONTROL_TIMEOUT_MS);
      this.pendingControls.set(requestId, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        timeout
      });
    });
    void this.channel
      .send(`${JSON.stringify({ type: 'control_request', request_id: requestId, request })}\n`)
      .catch((error) => {
        const pending = this.pendingControls.get(requestId);
        if (!pending) return;
        this.pendingControls.delete(requestId);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    return result;
  }

  private consumeControlResponse(line: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return false;
    }
    const envelope = record(parsed);
    if (envelope?.type !== 'control_response') return false;
    const response = record(envelope.response);
    if (!response) return true;
    const requestId = typeof response?.request_id === 'string' ? response.request_id : undefined;
    if (!requestId) return true;
    const pending = this.pendingControls.get(requestId);
    if (!pending) return true;
    this.pendingControls.delete(requestId);
    if (response.subtype === 'success') {
      pending.resolve(record(response.response) ?? {});
    } else {
      pending.reject(
        new Error(typeof response.error === 'string' ? response.error : 'Claude Code control request failed')
      );
    }
    return true;
  }

  private async emitOutput(line: string, sink: MeshAgentEventSink): Promise<void> {
    for (const event of this.options.parseOutput(`${line}\n`)) {
      if (event.type === 'session_ref') {
        const providerSessionRef = event.payload.providerSessionRef;
        if (typeof providerSessionRef === 'string' && providerSessionRef) {
          await sink.emit({ type: 'provider_session_identified', payload: { providerSessionRef } });
        }
        continue;
      }
      await sink.emit(event as MeshAgentSessionEvent);
    }
  }

  private rejectPending(error: Error): void {
    for (const [requestId, pending] of this.pendingControls) {
      this.pendingControls.delete(requestId);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  private resetDecoders(): void {
    this.decoders['provider-channel'] = new TextDecoder();
    this.decoders.stdout = new TextDecoder();
    this.pending['provider-channel'] = '';
    this.pending.stdout = '';
  }
}
