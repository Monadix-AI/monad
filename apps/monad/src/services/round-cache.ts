// RoundCache — in-process hot tier for resumable streaming.
//
// The active round's events are buffered in-process so a client reconnecting mid-turn can replay the
// un-persisted tail (canonical message deltas are never written to the durable log). Once the
// round settles, persistAndRetire drops the buffer and the durable event log is the source of truth.

import type { Event, EventId } from '@monad/protocol';

export type LiveEventAnchorStatus = 'live' | 'other_scope' | 'missing';

// Keyed by plain string, not `SessionId`: a round can belong to a Workplace Project's own
// project-wide fan-out (a `prj_` id), which is not a `SessionId` on the wire — see
// apps/monad/src/handlers/session/context.ts's `SessionOrProject` TODO(track-b) for the pending
// design decision this is scaffolding around.
export class RoundCache {
  private readonly bySession = new Map<string, Event[]>();

  /** Append an event to the session's active round buffer. */
  append(event: Event): void {
    const buf = this.bySession.get(event.sessionId);
    if (buf) buf.push(event);
    else this.bySession.set(event.sessionId, [event]);
  }

  /**
   * Buffered events for a fresh subscription, or after an exclusive known anchor. Unknown anchors
   * return an empty result and must be resolved explicitly by the caller.
   */
  since(sessionId: string, afterEventId?: string, limit?: number): Event[] {
    const buf = this.bySession.get(sessionId);
    if (!buf) return [];
    if (!afterEventId) return limit === undefined ? [...buf] : buf.slice(0, limit);
    const idx = buf.findIndex((e) => e.id === afterEventId);
    if (idx === -1) return [];
    return limit === undefined ? buf.slice(idx + 1) : buf.slice(idx + 1, idx + 1 + limit);
  }

  anchorStatus(sessionId: string, eventId: EventId): LiveEventAnchorStatus {
    const expected = this.bySession.get(sessionId);
    if (expected?.some((event) => event.id === eventId)) return 'live';
    for (const [scope, events] of this.bySession) {
      if (scope !== sessionId && events.some((event) => event.id === eventId)) return 'other_scope';
    }
    return 'missing';
  }

  eventsAfterKnownAnchor(sessionId: string, eventId: EventId): Event[] {
    const buf = this.bySession.get(sessionId);
    if (!buf) return [];
    const index = buf.findIndex((event) => event.id === eventId);
    return index === -1 ? [] : buf.slice(index + 1);
  }

  /** Newest buffered event id for the active round, or undefined when no round is in flight. The
   *  active round's tail is always newer than the durable log because rounds are retired only after
   *  persistence — so this takes precedence over the store's latest durable id for snapshot cursors. */
  latestEventId(sessionId: string): EventId | undefined {
    const buf = this.bySession.get(sessionId);
    if (!buf || buf.length === 0) return undefined;
    return buf[buf.length - 1]?.id;
  }

  /** Drop the in-process buffer once the round has been persisted. */
  retire(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
