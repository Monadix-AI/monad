import type { AgentObservationEvent, Event, SessionId, SessionMemberUiObservationFrame } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';

import { isMonadAgentDomainEvent, toAgentObservationEvent } from '#/agent/observation.ts';

/** Neutral observation for a `monad`-typed session member (Track B `session_members`): the daemon's own
 *  built-in agent has no `meshSessionId`, so it can't ride the `/mesh/sessions/:id/events/convenience`
 *  plane — its raw source is the session's own domain `Event` log (see
 *  `apps/monad/src/agent/observation.ts`), filtered to the events that member itself produced. Scoped to
 *  the `monad` member only; ACP-typed members are not yet observable this way (see the implementation-
 *  order proposal's P5 deviations). */
export function createSessionMemberObservationHandlers(ctx: SessionContext) {
  const {
    deps: { store, bus, cache },
    aborts,
    requireSession
  } = ctx;

  function isObservableMonadMember(sessionId: SessionId, memberId: string): boolean {
    return store.getSessionMember(sessionId, memberId)?.type === 'monad';
  }

  // Mirrors `subscribe()`'s durable/buffered split (messaging-subscribe.ts): a persisted cursor
  // covers completed rounds since it (the buffer alone would drop every finished round between the
  // cursor and the active one), a cursor `listEvents` doesn't recognize (an un-persisted, in-flight
  // event id) falls back to the buffered tail alone, and a fresh subscribe replays everything.
  function replayEvents(sessionId: SessionId, afterEventId?: string): Event[] {
    const buffered = cache.since(sessionId, afterEventId);
    if (afterEventId !== undefined && store.hasEvent(sessionId, afterEventId)) {
      const durable = store.listEvents(sessionId, afterEventId);
      const seen = new Set(durable.map((e) => e.id));
      return [...durable, ...buffered.filter((e) => !seen.has(e.id))];
    }
    return buffered.length > 0 ? buffered : store.listEvents(sessionId, afterEventId);
  }

  function toAgentObservationEvents(events: Event[]): AgentObservationEvent[] {
    const out: AgentObservationEvent[] = [];
    for (const event of events) {
      if (!isMonadAgentDomainEvent(event)) continue;
      const mapped = toAgentObservationEvent(event);
      if (mapped) out.push(mapped);
    }
    return out;
  }

  function unavailableFrame(sessionId: SessionId, memberId: string, reason: string): SessionMemberUiObservationFrame {
    return { state: 'unavailable', sessionId, memberId, reason };
  }

  // The replay cursor is the last DOMAIN event folded in, not the last neutral-mapped one: a
  // system/status event that `toAgentObservationEvent` drops still advances the cursor, so a
  // resume never re-replays it looking for a mapped event that will never arrive.
  function liveFrame(
    sessionId: SessionId,
    memberId: string,
    state: 'live' | 'events',
    operation: 'replace' | 'append',
    events: Event[]
  ): SessionMemberUiObservationFrame {
    const cursor = events.at(-1)?.id;
    return {
      state,
      operation,
      sessionId,
      memberId,
      events: toAgentObservationEvents(events),
      ...(cursor ? { cursor } : {}),
      observedAt: new Date().toISOString()
    };
  }

  function observeMemberUi({
    sessionId,
    memberId,
    afterEventId
  }: {
    sessionId: SessionId;
    memberId: string;
    afterEventId?: string;
  }): SessionMemberUiObservationFrame {
    requireSession(sessionId);
    if (!isObservableMonadMember(sessionId, memberId)) {
      return unavailableFrame(sessionId, memberId, 'observation is only wired for the monad built-in agent member');
    }
    return liveFrame(
      sessionId,
      memberId,
      aborts.has(sessionId) ? 'live' : 'events',
      'replace',
      replayEvents(sessionId, afterEventId)
    );
  }

  function subscribeMemberUiObservation(
    { sessionId, memberId, afterEventId }: { sessionId: SessionId; memberId: string; afterEventId?: string },
    sink: (frame: SessionMemberUiObservationFrame) => void
  ): { dispose: () => void } {
    requireSession(sessionId);
    if (!isObservableMonadMember(sessionId, memberId)) {
      sink(unavailableFrame(sessionId, memberId, 'observation is only wired for the monad built-in agent member'));
      return { dispose: () => {} };
    }
    sink(
      liveFrame(
        sessionId,
        memberId,
        aborts.has(sessionId) ? 'live' : 'events',
        'replace',
        replayEvents(sessionId, afterEventId)
      )
    );
    const dispose = bus.subscribe(sessionId, (event) => {
      if (!isMonadAgentDomainEvent(event)) return;
      sink(liveFrame(sessionId, memberId, 'live', 'append', [event]));
    });
    return { dispose };
  }

  return { observeMemberUi, subscribeMemberUiObservation };
}
