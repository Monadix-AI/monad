import type { Event } from '@monad/protocol';
import type { EventBus } from '#/services/event-bus.ts';
import type { Store } from '#/store/db/index.ts';

import { transcriptTargetIdSchema } from '@monad/protocol';

import { makeEvent } from '#/services/event-bus.ts';

interface MeshAgentEventLogDeps {
  store: Store;
  bus: EventBus;
}

/** Builds and dispatches MeshAgent session events, split by durability: `emit` persists a milestone
 *  (started/exited/approval/…) to the event log before publishing it; `publish` is fire-and-forget for
 *  high-frequency output chunks the bounded per-session snapshot already captures. */
export class MeshAgentEventLog {
  constructor(private readonly deps: MeshAgentEventLogDeps) {}

  private build(sessionId: string, type: Event['type'], payload: Record<string, unknown>): Event {
    return makeEvent(transcriptTargetIdSchema.parse(sessionId), type, payload);
  }

  /** Durable milestone event (started/exited/approval/…): persisted to the event log and published. */
  emit(sessionId: string, type: Event['type'], payload: Record<string, unknown>): void {
    const event = this.build(sessionId, type, payload);
    this.deps.store.appendEvents([event]);
    this.deps.bus.publish(event);
  }

  /** Publish-only (never persisted). For high-frequency transient signals delivered live over the bus
   *  where one durable row per event would grow the event log without bound. Live mesh-agent output
   *  is captured in the bounded per-session output snapshot instead, and hydration rebuilds the tool card
   *  from that snapshot (see SessionUiProjector.hydrateMeshSessions), so no durable rows are needed. */
  publish(sessionId: string, type: Event['type'], payload: Record<string, unknown>): void {
    this.deps.bus.publish(this.build(sessionId, type, payload));
  }
}
