import type { MeshAgentRuntimeCapabilities } from '@monad/protocol';
import type {
  MeshAgentEventSink,
  MeshAgentOutputEvent,
  PerTurnProviderDriver,
  SessionEventPacket,
  TurnProcessResult
} from '@monad/sdk-atom';

interface SessionEventJsonlDriverOptions {
  parseOutput(chunk: string): MeshAgentOutputEvent[];
  capabilities?: Partial<MeshAgentRuntimeCapabilities>;
}

const BASE_CAPABILITIES: MeshAgentRuntimeCapabilities = {
  input: true,
  steer: false,
  interrupt: false,
  approvalResolution: false,
  providerSessionContinuation: true,
  runtimeRestoration: true,
  sessionReopen: true
};

export class SessionEventJsonlDriver implements PerTurnProviderDriver {
  readonly processModel = 'per-turn' as const;
  readonly controls = { approvalResolution: false, steer: false, interrupt: false } as const;
  private decoder = new TextDecoder();
  private pending = '';
  private sink?: MeshAgentEventSink;

  constructor(private readonly options: SessionEventJsonlDriverOptions) {}

  async openSession() {
    return { capabilities: { ...BASE_CAPABILITIES, ...this.options.capabilities } };
  }

  async attachTurnChannel(): Promise<void> {
    this.decoder = new TextDecoder();
    this.pending = '';
    this.sink = undefined;
  }

  async accept(packet: SessionEventPacket, sink: MeshAgentEventSink): Promise<void> {
    this.sink = sink;
    this.pending += this.decoder.decode(packet.bytes, { stream: true });
    await this.flushCompleteLines();
  }

  async completeTurn(_result: TurnProcessResult): Promise<void> {
    this.pending += this.decoder.decode();
    if (this.pending.trim()) await this.emitParsed(`${this.pending}\n`);
    this.pending = '';
    this.sink = undefined;
  }

  async dispose(): Promise<void> {
    this.pending = '';
    this.sink = undefined;
  }

  private async flushCompleteLines(): Promise<void> {
    const boundary = this.pending.lastIndexOf('\n');
    if (boundary < 0) return;
    const complete = this.pending.slice(0, boundary + 1);
    this.pending = this.pending.slice(boundary + 1);
    await this.emitParsed(complete);
  }

  private async emitParsed(chunk: string): Promise<void> {
    if (!this.sink) throw new Error('session-event JSONL driver has no active sink');
    for (const event of this.options.parseOutput(chunk)) {
      if (event.type === 'session_ref') {
        const providerSessionRef = event.payload.providerSessionRef;
        if (typeof providerSessionRef === 'string' && providerSessionRef) {
          await this.sink.emit({ type: 'provider_session_identified', payload: { providerSessionRef } });
        }
        continue;
      }
      await this.sink.emit(event);
    }
  }
}
