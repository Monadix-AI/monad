// RoundCache — in-process hot tier for resumable streaming.
//
// The active round's events are buffered in-process so a client reconnecting mid-turn can replay the
// un-persisted tail (canonical message deltas are never written to the durable log). Once the
// round settles, persistAndRetire drops the buffer and the durable event log is the source of truth.

import type { Event } from '@monad/protocol';

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
   * Buffered events for a session after an exclusive `afterEventId` cursor. Empty when no active
   * round is buffered (settled/never-started) — the caller falls back to the durable event log.
   */
  since(sessionId: string, afterEventId?: string): Event[] {
    const buf = this.bySession.get(sessionId);
    if (!buf) return [];
    if (!afterEventId) return [...buf];
    const idx = buf.findIndex((e) => e.id === afterEventId);
    return idx === -1 ? [...buf] : buf.slice(idx + 1);
  }

  /** Drop the in-process buffer once the round has been persisted. */
  retire(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
