import type { AgentObservationEvent, SessionId, SessionMemberUiObservationFrame } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';

import { isMonadAgentDomainEvent, toAgentObservationEvent } from '#/agent/observation.ts';

/** Neutral observation for a `monad`-typed session member (Track B `session_members`): the daemon's own
 *  built-in agent has no `externalAgentSessionId`, so it can't ride the `/external-agent-sessions/:id/
 *  ui-observation` plane — its raw source is the session's own domain `Event` log (see
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

  // Full point-in-time projection: persisted history plus the active round's un-persisted tail
  // (canonical message deltas live only in the round cache — see `RoundCache`/
  // `persistAndRetire` in `handlers/session/context.ts`), merged in emission order. Re-derived on every
  // call, mirroring `ExternalAgentObservationResolver.observeUi`'s "re-derive from the whole snapshot,
  // never a delta" contract so a consumer always replaces its list wholesale.
  function projectEvents(sessionId: SessionId): AgentObservationEvent[] {
    const events: AgentObservationEvent[] = [];
    for (const event of [...store.listEvents(sessionId), ...cache.since(sessionId)]) {
      if (!isMonadAgentDomainEvent(event)) continue;
      const mapped = toAgentObservationEvent(event);
      if (mapped) events.push(mapped);
    }
    return events;
  }

  function unavailableFrame(sessionId: SessionId, memberId: string, reason: string): SessionMemberUiObservationFrame {
    return { state: 'unavailable', sessionId, memberId, reason };
  }

  function observeMemberUi({
    sessionId,
    memberId
  }: {
    sessionId: SessionId;
    memberId: string;
  }): SessionMemberUiObservationFrame {
    requireSession(sessionId);
    if (!isObservableMonadMember(sessionId, memberId)) {
      return unavailableFrame(sessionId, memberId, 'observation is only wired for the monad built-in agent member');
    }
    return {
      state: aborts.has(sessionId) ? 'live' : 'history',
      sessionId,
      memberId,
      events: projectEvents(sessionId),
      observedAt: new Date().toISOString()
    };
  }

  function subscribeMemberUiObservation(
    { sessionId, memberId }: { sessionId: SessionId; memberId: string },
    sink: (frame: SessionMemberUiObservationFrame) => void
  ): { dispose: () => void } {
    requireSession(sessionId);
    if (!isObservableMonadMember(sessionId, memberId)) {
      sink(unavailableFrame(sessionId, memberId, 'observation is only wired for the monad built-in agent member'));
      return { dispose: () => {} };
    }
    sink({
      state: aborts.has(sessionId) ? 'live' : 'history',
      sessionId,
      memberId,
      events: projectEvents(sessionId),
      observedAt: new Date().toISOString()
    });
    const dispose = bus.subscribe(sessionId, (event) => {
      if (!isMonadAgentDomainEvent(event)) return;
      const mapped = toAgentObservationEvent(event);
      if (!mapped) return;
      sink({ state: 'live', sessionId, memberId, events: [mapped], observedAt: new Date().toISOString() });
    });
    return { dispose };
  }

  return { observeMemberUi, subscribeMemberUiObservation };
}
