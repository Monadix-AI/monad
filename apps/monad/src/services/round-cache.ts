// RoundCache — hot tier for resumable streaming.
//
// Primary: in-process Map for zero-latency append + replay within the daemon.
// Secondary: KV backing so a reconnecting client in a different process can
// resume mid-round even if the in-process buffer isn't available.
// KV cleanup is handled by persistAndRetire via kv.keys('run:{sessionId}:*').

import type { Event, SessionId } from '@monad/protocol';
import type { KvService } from '@/services/kv.ts';

export class RoundCache {
  private readonly bySession = new Map<SessionId, Event[]>();
  private readonly kv?: Pick<KvService, 'get' | 'set'>;

  constructor(kv?: Pick<KvService, 'get' | 'set'>) {
    this.kv = kv;
  }

  /** Append an event to the session's active round buffer. */
  append(event: Event): void {
    const buf = this.bySession.get(event.sessionId);
    if (buf) buf.push(event);
    else this.bySession.set(event.sessionId, [event]);
    if (this.kv) {
      const current = this.bySession.get(event.sessionId) as Event[];
      this.kv.set(`run:${event.sessionId}:round`, JSON.stringify(current), { ex: 120 });
    }
  }

  /**
   * Buffered events for a session after an exclusive `afterEventId` cursor.
   * Falls back to KV when the in-process buffer is absent (cross-process reconnect).
   * Returns empty when neither source has data — caller falls back to the durable log.
   */
  async since(sessionId: SessionId, afterEventId?: string): Promise<Event[]> {
    const buf = this.bySession.get(sessionId);
    if (buf) {
      if (!afterEventId) return [...buf];
      const idx = buf.findIndex((e) => e.id === afterEventId);
      return idx === -1 ? [...buf] : buf.slice(idx + 1);
    }
    if (this.kv) {
      const raw = await this.kv.get(`run:${sessionId}:round`);
      if (raw) {
        const events: Event[] = JSON.parse(raw);
        if (!afterEventId) return events;
        const idx = events.findIndex((e) => e.id === afterEventId);
        return idx === -1 ? events : events.slice(idx + 1);
      }
    }
    return [];
  }

  /** Drop the in-process buffer once the round has been persisted. */
  retire(sessionId: SessionId): void {
    this.bySession.delete(sessionId);
  }
}
