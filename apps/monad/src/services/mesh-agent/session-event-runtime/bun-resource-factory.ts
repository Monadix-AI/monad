import type { SessionEventPacket } from '@monad/sdk-atom';
import type { MeshAgentProcess } from '#/services/mesh-agent/runtime-types.ts';
import type {
  SessionEventRuntimeActivation,
  SessionEventRuntimeResourceFactory,
  SessionEventRuntimeStartRequest
} from './types.ts';

import { killMeshAgentProcess } from '#/services/mesh-agent/process.ts';
import {
  SESSION_EVENT_MAX_PACKET_BYTES,
  SESSION_EVENT_MAX_QUEUED_BYTES
} from '#/services/mesh-agent/session-event-runtime/event-sink.ts';

interface BunSessionEventRuntimeResourceFactoryOptions {
  buildEnv(env?: Record<string, string>): Promise<Record<string, string>>;
  onSpawn?(pid: number): Promise<void>;
  onExit?(pid: number): void;
  maxQueuedPacketBytes?: number;
}

type ByteReadResult = { done: boolean; value?: Uint8Array };

class PacketQueue {
  private readonly queued: SessionEventPacket[] = [];
  private readonly readers: Array<{
    read(): Promise<ByteReadResult>;
    cancel(): Promise<void>;
  }> = [];
  private wait?: () => void;
  private activeReaders = 0;
  private queuedBytes = 0;
  private closed = false;
  private failure?: Error;
  private cancellation?: Promise<void>;

  constructor(
    private readonly maxQueuedBytes = SESSION_EVENT_MAX_QUEUED_BYTES,
    private readonly maxPacketBytes = SESSION_EVENT_MAX_PACKET_BYTES
  ) {}

  add(stream: ReadableStream<Uint8Array> | undefined, source: 'stdout' | 'stderr'): void {
    if (!stream) return;
    this.activeReaders += 1;
    const reader = stream.getReader();
    this.readers.push(reader);
    void this.read(reader, source);
  }

  async *packets(): AsyncIterable<SessionEventPacket> {
    while (!this.closed && (this.activeReaders > 0 || this.queued.length > 0)) {
      if (this.failure) throw this.failure;
      const packet = this.queued.shift();
      if (packet) {
        this.queuedBytes -= packet.bytes.byteLength;
        yield packet;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.wait = resolve;
      });
    }
    if (this.failure) throw this.failure;
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.queued.length = 0;
      this.queuedBytes = 0;
      this.wake();
    }
    await this.cancelReaders();
  }

  private async read(reader: { read(): Promise<ByteReadResult> }, source: 'stdout' | 'stderr'): Promise<void> {
    try {
      while (!this.closed) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          if (value.byteLength > this.maxPacketBytes) {
            this.fail(new Error('session-event packet exceeded its byte limit'));
            break;
          }
          if (this.queuedBytes + value.byteLength > this.maxQueuedBytes) {
            this.fail(new Error('session-event packet queue byte limit exceeded'));
            break;
          }
          const bytes = value.slice();
          this.queued.push({ bytes, source, receivedAt: new Date().toISOString() });
          this.queuedBytes += bytes.byteLength;
          this.wake();
        }
      }
    } finally {
      this.activeReaders -= 1;
      this.wake();
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.closed = true;
    this.queued.length = 0;
    this.queuedBytes = 0;
    void this.cancelReaders();
    this.wake();
  }

  private cancelReaders(): Promise<void> {
    this.cancellation ??= Promise.all(this.readers.map((reader) => reader.cancel().catch(() => undefined))).then(
      () => undefined
    );
    return this.cancellation;
  }

  private wake(): void {
    const wake = this.wait;
    this.wait = undefined;
    wake?.();
  }
}

export class BunSessionEventRuntimeResourceFactory implements SessionEventRuntimeResourceFactory {
  constructor(private readonly options: BunSessionEventRuntimeResourceFactoryOptions) {}

  async start(request: SessionEventRuntimeStartRequest): Promise<SessionEventRuntimeActivation> {
    if (request.channel.kind !== 'child-stdio') {
      throw new Error(`session-event channel is not implemented by the Bun resource factory: ${request.channel.kind}`);
    }
    if (request.signal.aborted) throw new Error('session-event runtime startup was cancelled');
    const env = await this.options.buildEnv(request.launch.env);
    const proc = Bun.spawn(request.launch.argv, {
      cwd: request.launch.cwd,
      env,
      detached: true,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe'
    }) as MeshAgentProcess;
    const packets = new PacketQueue(this.options.maxQueuedPacketBytes);
    packets.add(proc.stdout, 'stdout');
    packets.add(proc.stderr, 'stderr');
    await this.options.onSpawn?.(proc.pid);
    const stdin = proc.stdin as unknown as
      | {
          write(input: string | Uint8Array): void;
          flush?(): void | Promise<void>;
          end?(): void | Promise<void>;
        }
      | undefined;
    let stdinClosed = false;
    let activationClosed = false;
    const closeStdin = async (): Promise<void> => {
      if (stdinClosed) return;
      stdinClosed = true;
      await stdin?.end?.();
    };
    const result = proc.exited.then((exitCode) => {
      this.options.onExit?.(proc.pid);
      return { exitCode };
    });
    const abort = (): void => killMeshAgentProcess(proc.pid, 'SIGTERM');
    request.signal.addEventListener('abort', abort, { once: true });
    return {
      process: {
        pid: proc.pid,
        result,
        async writeStdin(bytes) {
          if (stdinClosed || !stdin) throw new Error('session-event process stdin is closed');
          stdin.write(bytes);
          await stdin.flush?.();
        },
        closeStdin,
        async kill(signal) {
          killMeshAgentProcess(proc.pid, signal);
        }
      },
      channel: {
        async send(frame) {
          if (stdinClosed || !stdin) throw new Error('session-event channel is closed');
          stdin.write(frame);
          await stdin.flush?.();
        },
        close: closeStdin
      },
      packets: () => packets.packets(),
      async close() {
        if (activationClosed) return;
        activationClosed = true;
        request.signal.removeEventListener('abort', abort);
        await closeStdin();
        await packets.close();
      }
    };
  }
}
