import type { Event, TranscriptTargetId } from '@monad/protocol';
import type { EventBus } from '@/services/event-bus.ts';
import type { Store } from '@/store/db/index.ts';

import { newId } from '@monad/protocol';

export interface ExternalAgentEventLogDeps {
  store: Store;
  bus: EventBus;
}

/** Builds and dispatches external agent session events, split by durability: `emit` persists a milestone
 *  (started/exited/approval/…) to the event log before publishing it; `publish` is fire-and-forget for
 *  high-frequency output chunks the bounded per-session snapshot already captures. */
export class ExternalAgentEventLog {
  constructor(private readonly deps: ExternalAgentEventLogDeps) {}

  private build(sessionId: TranscriptTargetId, type: Event['type'], payload: Record<string, unknown>): Event {
    return {
      id: newId('evt'),
      transcriptTargetId: sessionId,
      type,
      actorAgentId: null,
      payload,
      at: new Date().toISOString()
    };
  }

  /** Durable milestone event (started/exited/approval/…): persisted to the event log and published. */
  emit(sessionId: TranscriptTargetId, type: Event['type'], payload: Record<string, unknown>): void {
    const event = this.build(sessionId, type, payload);
    this.deps.store.appendEvents([event]);
    this.deps.bus.publish(event);
  }

  /** Publish-only (never persisted). For high-frequency `external_agent.output` chunks: delivered live over
   *  the bus and captured in the bounded per-session output snapshot, so one durable row per chunk would
   *  grow the event log without bound. Hydration rebuilds the tool card from that snapshot instead
   *  (see SessionUiProjector.hydrateExternalAgentSessions), so no durable output rows are needed. */
  publish(sessionId: TranscriptTargetId, type: Event['type'], payload: Record<string, unknown>): void {
    this.deps.bus.publish(this.build(sessionId, type, payload));
  }
}
