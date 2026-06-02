import type { MeshAgentRuntimeCapabilities, MeshAgentTurnInput } from '@monad/protocol';
import type {
  MeshAgentEventSink,
  ResidentProviderDriver,
  SessionEventChannel,
  SessionEventChannelContext,
  SessionEventPacket
} from '@monad/sdk-atom';
import type { QwenStreamJsonContext } from './stream-json.ts';

import { parseQwenStreamJson } from './stream-json.ts';

const CAPABILITIES: MeshAgentRuntimeCapabilities = {
  input: true,
  steer: true,
  interrupt: true,
  approvalResolution: true,
  providerSessionContinuation: true,
  runtimeRestoration: true,
  sessionReopen: true
};

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function turnText(input: MeshAgentTurnInput): string {
  if (input.attachments.length === 0) return input.text;
  const references = input.attachments.map((attachment) => `- ${attachment.name}: ${attachment.path}`).join('\n');
  return `${input.text}\n\nAttachments available in the workspace:\n${references}`;
}

export class QwenSessionEventDriver implements ResidentProviderDriver {
  readonly processModel = 'resident' as const;
  readonly controls = {
    approvalResolution: { resolve: (resolution) => this.resolveApproval(resolution) },
    steer: { send: (input) => this.sendTurn(input) },
    interrupt: { run: () => this.interrupt() }
  } as ResidentProviderDriver['controls'];
  private channel?: SessionEventChannel;
  private parserContext?: QwenStreamJsonContext;
  private providerSessionRef?: string;
  private pending = '';
  private decoder = new TextDecoder();
  private requestSequence = 0;
  private readonly approvals = new Map<string, Record<string, unknown>>();

  async openSession() {
    return { capabilities: CAPABILITIES };
  }

  async attachChannel(channel: SessionEventChannel, context: SessionEventChannelContext) {
    this.channel = channel;
    this.providerSessionRef = context.providerSessionRef;
    this.parserContext = { stdin: { write: (value) => void channel.send(value) } };
    await channel.send(
      line({
        type: 'control_request',
        request_id: `init-${this.requestSequence++}`,
        request: { subtype: 'initialize', hooks: null }
      })
    );
    return undefined;
  }

  async sendTurn(input: MeshAgentTurnInput): Promise<void> {
    if (!this.channel) throw new Error('Qwen session-event channel is not attached');
    await this.channel.send(
      line({
        type: 'user',
        session_id: this.providerSessionRef ?? '',
        parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text: turnText(input) }] }
      })
    );
  }

  async accept(packet: SessionEventPacket, sink: MeshAgentEventSink): Promise<void> {
    this.pending += this.decoder.decode(packet.bytes, { stream: true });
    const boundary = this.pending.lastIndexOf('\n');
    if (boundary < 0) return;
    const complete = this.pending.slice(0, boundary + 1);
    this.pending = this.pending.slice(boundary + 1);
    for (const event of parseQwenStreamJson(complete, this.parserContext)) {
      if (event.type === 'session_ref') {
        const providerSessionRef = event.payload.providerSessionRef;
        if (typeof providerSessionRef === 'string' && providerSessionRef) {
          this.providerSessionRef = providerSessionRef;
          await sink.emit({ type: 'provider_session_identified', payload: { providerSessionRef } });
        }
        continue;
      }
      if (event.type === 'approval_requested') {
        this.approvals.set(String(event.payload.requestId), event.payload);
      }
      await sink.emit(event);
    }
  }

  async dispose(): Promise<void> {
    this.pending = '';
    this.decoder = new TextDecoder();
    this.approvals.clear();
    await this.channel?.close();
    this.channel = undefined;
    this.parserContext = undefined;
    this.providerSessionRef = undefined;
  }

  private async resolveApproval(resolution: { requestId: string; allow: boolean; reason?: string }): Promise<void> {
    if (!this.channel) throw new Error('Qwen session-event channel is not attached');
    const request = this.approvals.get(resolution.requestId);
    const response = resolution.allow
      ? { behavior: 'allow', updatedInput: request?.input ?? {} }
      : { behavior: 'deny', message: resolution.reason ?? 'Denied' };
    await this.channel.send(
      line({
        type: 'control_response',
        response: { subtype: 'success', request_id: resolution.requestId, response }
      })
    );
    this.approvals.delete(resolution.requestId);
  }

  private async interrupt(): Promise<void> {
    if (!this.channel) throw new Error('Qwen session-event channel is not attached');
    await this.channel.send(
      line({
        type: 'control_request',
        request_id: `interrupt-${this.requestSequence++}`,
        request: { subtype: 'interrupt' }
      })
    );
  }
}
