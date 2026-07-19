import type { Event, EventType, TranscriptTargetId } from '@monad/protocol';

import { EventEmitter } from 'node:events';
import { eventDefinition, newId } from '@monad/protocol';

export type EventSink = (event: Event) => void;

/** Single constructor for the wire Event envelope — every daemon-emitted event goes through here.
 *  `payload` is `object` (not `Event['payload']`) so typed payload shapes without an index
 *  signature pass without a call-site cast; the wire schema validates the record shape anyway. */
export function makeEvent(
  sessionId: TranscriptTargetId,
  type: EventType,
  payload: object,
  opts?: Pick<Partial<Event>, 'actorAgentId' | 'at'>
): Event {
  return {
    id: newId('evt'),
    sessionId,
    type,
    actorAgentId: opts?.actorAgentId ?? null,
    payload: payload as Event['payload'],
    at: opts?.at ?? new Date().toISOString()
  };
}

/**
 * Event types that describe session-list-level state rather than in-session
 * detail. These fan out to the `control` topic so a client can keep its session
 * list / dashboard live without knowing each session id in advance — e.g. another
 * UI creates a session and every connected TUI/web client sees it appear.
 *
 * In-session detail (`agent.*`, `tool.*`) stays session-scoped: it only matters to
 * a client actively viewing that session, which subscribes by id.
 */
/**
 * Topic a sink can subscribe to. `session:<id>` carries one session's full event
 * stream; `control` carries the cross-session, list-level slice. Modelled as a
 * string so the topic axis can later widen without
 * touching the publish/subscribe plumbing.
 */
// Keyed by plain string, not `SessionId`: a project-wide fan-out publishes/subscribes under its own
// `prj_` id — see apps/monad/src/handlers/session/context.ts's `SessionOrProject` TODO(track-b).
type Topic = `session:${string}` | 'control' | 'all';

const CONTROL_TOPIC = 'control' as const;
const ALL_TOPIC = 'all' as const;

const sessionTopic = (sessionId: string): Topic => `session:${sessionId}`;

/** In-process pub/sub. Every control-API WS/SSE push originates here. */
export class EventBus {
  private readonly events = new EventEmitter().setMaxListeners(0);

  /** Subscribe to one session's full event stream. */
  subscribe(sessionId: string, sink: EventSink): () => void {
    return this.subscribeTopic(sessionTopic(sessionId), sink);
  }

  /**
   * Subscribe to the cross-session control stream: session-list-level changes
   * (create/update/delete/branch/restore, task lifecycle) across all sessions.
   * Used by clients that mirror global state rather than a single session.
   */
  subscribeControl(sink: EventSink): () => void {
    return this.subscribeTopic(CONTROL_TOPIC, sink);
  }

  /** Internal generic-runtime feed. Unlike control, this includes approval/tool detail. */
  subscribeAll(sink: EventSink): () => void {
    return this.subscribeTopic(ALL_TOPIC, sink);
  }

  publish(event: Event): void {
    this.emit(sessionTopic(event.sessionId), event);
    this.emit(ALL_TOPIC, event);
    // List-level events also reach control subscribers. A sink subscribed to both
    // the session and control topics receives the event twice — clients dedupe by
    // `event.id` (events are idempotent by id).
    const delivery = eventDefinition(event.type).delivery;
    if (delivery === 'control' || delivery === 'both') this.emit(CONTROL_TOPIC, event);
  }

  private subscribeTopic(topic: Topic, sink: EventSink): () => void {
    this.events.on(topic, sink);
    return () => this.events.off(topic, sink);
  }

  private emit(topic: Topic, event: Event): void {
    this.events.emit(topic, event);
  }
}
