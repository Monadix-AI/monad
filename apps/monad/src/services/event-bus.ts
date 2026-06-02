import type { Event, EventType, SessionId } from '@monad/protocol';

export type EventSink = (event: Event) => void;

/**
 * Event types that describe session-list-level state rather than in-session
 * detail. These fan out to the `control` topic so a client can keep its session
 * list / dashboard live without knowing each session id in advance — e.g. another
 * UI creates a session and every connected TUI/web client sees it appear.
 *
 * In-session detail (`agent.*`, `tool.*`) stays session-scoped: it only matters to
 * a client actively viewing that session, which subscribes by id.
 */
const CONTROL_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'session.created',
  'session.updated',
  'session.deleted',
  'session.branched',
  'session.restored',
  'session.stream_started',
  'session.stream_ended',
  'task.created',
  'task.progress',
  'task.completed',
  'task.failed'
]);

/**
 * Topic a sink can subscribe to. `session:<id>` carries one session's full event
 * stream; `control` carries the cross-session, list-level slice. Modelled as a
 * string so the topic axis can later widen (e.g. `principal:<id>`) without
 * touching the publish/subscribe plumbing.
 */
type Topic = `session:${SessionId}` | 'control';

const CONTROL_TOPIC = 'control' as const;

const sessionTopic = (sessionId: SessionId): Topic => `session:${sessionId}`;

/** In-process pub/sub. Every control-API WS/SSE push originates here. */
export class EventBus {
  private readonly subs = new Map<Topic, Set<EventSink>>();

  /** Subscribe to one session's full event stream. */
  subscribe(sessionId: SessionId, sink: EventSink): () => void {
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

  publish(event: Event): void {
    this.emit(sessionTopic(event.sessionId), event);
    // List-level events also reach control subscribers. A sink subscribed to both
    // the session and control topics receives the event twice — clients dedupe by
    // `event.id` (events are idempotent by id).
    if (CONTROL_EVENT_TYPES.has(event.type)) this.emit(CONTROL_TOPIC, event);
  }

  private subscribeTopic(topic: Topic, sink: EventSink): () => void {
    let set = this.subs.get(topic);
    if (!set) {
      set = new Set();
      this.subs.set(topic, set);
    }
    set.add(sink);
    return () => {
      set?.delete(sink);
      if (set && set.size === 0) this.subs.delete(topic);
    };
  }

  private emit(topic: Topic, event: Event): void {
    const set = this.subs.get(topic);
    if (!set) return;
    for (const sink of set) sink(event);
  }
}
