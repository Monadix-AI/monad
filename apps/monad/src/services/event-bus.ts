import type { Event, EventType } from '@monad/protocol';

import { EventEmitter } from 'node:events';

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
  'session.restored',
  'session.stream_started',
  'session.stream_ended',
  // A external agent session appearing/ending in a project is list-level: a client keeping the
  // external agent session list live (to observe an agent, drive rail presence) subscribes to control,
  // not to each project id. Without these on control the list only refreshes on a manual reload.
  'external_agent.started',
  'external_agent.exited',
  'task.created',
  'task.progress',
  'task.completed',
  'task.failed',
  'mcp.status_updated'
]);

/**
 * Topic a sink can subscribe to. `session:<id>` carries one session's full event
 * stream; `control` carries the cross-session, list-level slice. Modelled as a
 * string so the topic axis can later widen (e.g. `principal:<id>`) without
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
    if (CONTROL_EVENT_TYPES.has(event.type)) this.emit(CONTROL_TOPIC, event);
  }

  private subscribeTopic(topic: Topic, sink: EventSink): () => void {
    this.events.on(topic, sink);
    return () => this.events.off(topic, sink);
  }

  private emit(topic: Topic, event: Event): void {
    this.events.emit(topic, event);
  }
}
