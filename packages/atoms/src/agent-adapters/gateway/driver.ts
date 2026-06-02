import type { MeshAgentRuntimeCapabilities, MeshAgentTurnInput } from '@monad/protocol';
import type {
  MeshAgentEventSink,
  ResidentProviderDriver,
  SessionEventChannel,
  SessionEventChannelContext,
  SessionEventPacket
} from '@monad/sdk-atom';
import type { GatewayHooks } from './hooks.ts';
import type { GatewayInitializeContext, GatewayRuntimeHandle } from './runtime.ts';

const CAPABILITIES: MeshAgentRuntimeCapabilities = {
  input: true,
  steer: true,
  interrupt: true,
  approvalResolution: true,
  providerSessionContinuation: true,
  runtimeRestoration: true,
  sessionReopen: true
};

interface GatewayDriverOptions {
  hooks: GatewayHooks;
  initialize: Omit<GatewayInitializeContext, 'providerSessionRef'>;
  providerSessionRef?: string;
}

export class GatewayDriver implements ResidentProviderDriver {
  readonly processModel = 'resident' as const;
  readonly controls = {
    approvalResolution: { resolve: (resolution) => this.resolveApproval(resolution) },
    steer: { send: (input) => this.steer(input) },
    interrupt: { run: () => this.interrupt() }
  } as ResidentProviderDriver['controls'];
  private channel?: SessionEventChannel;
  private handle?: GatewayRuntimeHandle;
  private requestSequence = 0;
  private sendTail: Promise<void> = Promise.resolve();
  private sendFailure?: Error;
  private ready = false;
  private readyError?: Error;
  private releaseReady?: () => void;
  private readonly readySignal = new Promise<void>((resolve) => {
    this.releaseReady = resolve;
  });

  constructor(private readonly options: GatewayDriverOptions) {}

  async openSession() {
    return {
      capabilities: CAPABILITIES,
      ...(this.options.providerSessionRef ? { providerSessionRef: this.options.providerSessionRef } : {})
    };
  }

  async attachChannel(channel: SessionEventChannel, context: SessionEventChannelContext) {
    this.channel = channel;
    this.handle = {
      providerSessionRef: context.providerSessionRef ?? null,
      gateway: {
        send: (value) => this.enqueueSend(value),
        close: () => {
          void channel.close();
        }
      },
      nextRequestId: () => this.requestSequence++,
      pendingRequests: new Map()
    };
    this.options.hooks.initialize(this.handle, {
      ...this.options.initialize,
      ...(context.providerSessionRef ? { providerSessionRef: context.providerSessionRef } : {})
    });
    await this.waitForSends();
    return undefined;
  }

  async sendTurn(input: MeshAgentTurnInput): Promise<void> {
    await this.requireReady();
    if (!this.handle) throw new Error('provider gateway channel is not attached');
    this.options.hooks.sendInput(this.handle, input.text);
    await this.waitForSends();
  }

  async accept(packet: SessionEventPacket, sink: MeshAgentEventSink): Promise<void> {
    if (packet.source !== 'provider-channel') return;
    const text = new TextDecoder().decode(packet.bytes);
    for (const event of this.options.hooks.parseOutput(text, this.handle)) {
      if (event.type === 'session_ref') {
        const providerSessionRef = event.payload.providerSessionRef;
        if (typeof providerSessionRef !== 'string' || !providerSessionRef) continue;
        if (this.handle) this.handle.providerSessionRef = providerSessionRef;
        this.markReady();
        await sink.emit({ type: 'provider_session_identified', payload: { providerSessionRef } });
        continue;
      }
      if (!this.ready && (event.type === 'connection_required' || event.type === 'provider_error')) {
        const message =
          typeof event.payload.reason === 'string'
            ? event.payload.reason
            : typeof event.payload.message === 'string'
              ? event.payload.message
              : 'provider gateway failed before opening a session';
        this.readyError = new Error(message);
        this.markReady();
      }
      await sink.emit(event);
    }
    await this.sendTail;
  }

  async dispose(): Promise<void> {
    this.readyError ??= new Error('provider gateway closed');
    this.markReady();
    const channel = this.channel;
    const handle = this.handle;
    this.channel = undefined;
    this.handle = undefined;
    if (handle) handle.gateway = undefined;
    const pendingSends = this.sendTail.catch(() => undefined);
    await channel?.close();
    await pendingSends;
  }

  private async steer(input: MeshAgentTurnInput): Promise<void> {
    await this.requireReady();
    if (!this.handle) throw new Error('provider gateway channel is not attached');
    this.options.hooks.steer(this.handle, input.text);
    await this.waitForSends();
  }

  private async interrupt(): Promise<void> {
    await this.requireReady();
    if (!this.handle) throw new Error('provider gateway channel is not attached');
    this.options.hooks.interrupt(this.handle);
    await this.waitForSends();
  }

  private enqueueSend(value: string): void {
    this.sendTail = this.sendTail
      .then(async () => {
        if (!this.channel) throw new Error('provider gateway channel is not attached');
        await this.channel.send(value);
      })
      .catch((error: unknown) => {
        this.sendFailure = error instanceof Error ? error : new Error(String(error));
        if (!this.ready) {
          this.readyError = this.sendFailure;
          this.markReady();
        }
      });
  }

  private async waitForSends(): Promise<void> {
    await this.sendTail;
    if (!this.sendFailure) return;
    const error = this.sendFailure;
    this.sendFailure = undefined;
    throw error;
  }

  private markReady(): void {
    if (this.ready) return;
    this.ready = true;
    this.releaseReady?.();
    this.releaseReady = undefined;
  }

  private async requireReady(): Promise<void> {
    await this.readySignal;
    if (this.readyError) throw this.readyError;
  }

  private async resolveApproval(resolution: { requestId: string; allow: boolean; reason?: string }): Promise<void> {
    await this.requireReady();
    if (!this.handle) throw new Error('provider gateway channel is not attached');
    this.options.hooks.resolveApproval(this.handle, resolution);
    await this.waitForSends();
  }
}
