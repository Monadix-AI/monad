import type { MeshAgentEventSink, MeshAgentSessionEvent, SessionEventPacket } from '@monad/sdk-atom';

import { MESH_AGENT_OUTPUT_SNAPSHOT_MAX } from '@monad/protocol';
import { meshAgentOutputEventSchema } from '@monad/sdk-atom';

export const SESSION_EVENT_MAX_PACKET_BYTES = MESH_AGENT_OUTPUT_SNAPSHOT_MAX;
export const SESSION_EVENT_MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_EVENTS_PER_PACKET = 256;

interface BoundedSessionEventIngressOptions {
  consume(event: MeshAgentSessionEvent): Promise<void>;
  onCancel?(error: Error): void;
  maxPacketBytes?: number;
  maxEventsPerPacket?: number;
  maxQueuedBytes?: number;
}

type DriverAccept = (packet: SessionEventPacket, sink: MeshAgentEventSink) => Promise<void>;

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function validatePacket(packet: SessionEventPacket, maxPacketBytes: number): void {
  if (!(packet.bytes instanceof Uint8Array)) throw new Error('session-event packet bytes are invalid');
  if (packet.bytes.byteLength > maxPacketBytes) throw new Error('session-event packet exceeded its byte limit');
  if (!['provider-channel', 'stdout', 'stderr'].includes(packet.source)) {
    throw new Error('session-event packet source is invalid');
  }
  if (typeof packet.receivedAt !== 'string' || !Number.isFinite(Date.parse(packet.receivedAt))) {
    throw new Error('session-event packet timestamp is invalid');
  }
}

function validateEvent(event: MeshAgentSessionEvent): MeshAgentSessionEvent {
  if (event?.type === 'provider_session_identified') {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (
      !payload ||
      Object.keys(payload).length !== 1 ||
      typeof payload.providerSessionRef !== 'string' ||
      payload.providerSessionRef.length === 0
    ) {
      throw new Error('provider session identity event is invalid');
    }
    return event;
  }
  const parsed = meshAgentOutputEventSchema.safeParse(event);
  if (!parsed.success) throw new Error('normalized MeshAgent session event is invalid');
  return parsed.data;
}

export class BoundedSessionEventIngress {
  private readonly consume: (event: MeshAgentSessionEvent) => Promise<void>;
  private readonly onCancel?: (error: Error) => void;
  private readonly maxPacketBytes: number;
  private readonly maxEventsPerPacket: number;
  private readonly maxQueuedBytes: number;
  private queuedBytes = 0;
  private tail: Promise<void> = Promise.resolve();
  private failure?: Error;
  private providerSessionRef?: string;

  constructor(options: BoundedSessionEventIngressOptions) {
    this.consume = options.consume;
    this.onCancel = options.onCancel;
    this.maxPacketBytes = options.maxPacketBytes ?? SESSION_EVENT_MAX_PACKET_BYTES;
    this.maxEventsPerPacket = options.maxEventsPerPacket ?? DEFAULT_MAX_EVENTS_PER_PACKET;
    this.maxQueuedBytes = options.maxQueuedBytes ?? SESSION_EVENT_MAX_QUEUED_BYTES;
  }

  ingest(packet: SessionEventPacket, accept: DriverAccept): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    try {
      validatePacket(packet, this.maxPacketBytes);
      if (this.queuedBytes + packet.bytes.byteLength > this.maxQueuedBytes) {
        throw new Error('session-event ingress exceeded its queued byte limit');
      }
    } catch (error) {
      return Promise.reject(this.cancel(errorOf(error)));
    }
    this.queuedBytes += packet.bytes.byteLength;
    const job = this.tail.then(async () => {
      try {
        if (this.failure) throw this.failure;
        await this.acceptPacket(packet, accept);
      } catch (error) {
        throw this.cancel(errorOf(error));
      } finally {
        this.queuedBytes -= packet.bytes.byteLength;
      }
    });
    this.tail = job.catch(() => {});
    return job;
  }

  private async acceptPacket(packet: SessionEventPacket, accept: DriverAccept): Promise<void> {
    let eventCount = 0;
    let eventTail = Promise.resolve();
    const sink: MeshAgentEventSink = {
      emit: async (candidate) => {
        if (this.failure) throw this.failure;
        eventCount += 1;
        if (eventCount > this.maxEventsPerPacket) {
          throw new Error('session-event packet exceeded its event limit');
        }
        const event = validateEvent(candidate);
        if (event.type === 'provider_session_identified') {
          const next = event.payload.providerSessionRef;
          if (this.providerSessionRef === next) return;
          if (this.providerSessionRef) throw new Error('provider session identity changed during a logical session');
          this.providerSessionRef = next;
        }
        eventTail = eventTail.then(() => this.consume(event));
        await eventTail;
      }
    };
    await accept(packet, sink);
    await eventTail;
  }

  private cancel(error: Error): Error {
    if (!this.failure) {
      this.failure = error;
      this.onCancel?.(error);
    }
    return this.failure;
  }
}
