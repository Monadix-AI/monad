import type { Event, SessionId, SessionUiEvent } from '@monad/protocol';
import type { EventSink, SessionContext } from '#/handlers/session/context.ts';

import { parseDurableSummary } from '#/agent/history.ts';
import { isChannelStructuredSession } from '#/handlers/session/handlers/messaging-members.ts';
import { SessionUiProjector } from '#/handlers/session/ui-projection.ts';

// Size of the live UI snapshot window. Older history is paged lazily over GET /ui-items.
// Keep ≥ a realistic single agent round so a tool call+result pair never straddles the window.
const LIVE_SNAPSHOT_LIMIT = 80;

/** Event/UI-projection read subscriptions for a session and the cross-session control stream.
 *  Extracted from messaging.ts because these are pure reads (replay + live subscribe) with no
 *  dependency on the send/route/deliver write path. */
export function createSubscribeHandlers(ctx: SessionContext) {
  const {
    deps: { bus, cache, store },
    requireSession
  } = ctx;

  async function subscribe(
    { sessionId, afterEventId }: { sessionId: SessionId; afterEventId?: string },
    sink: EventSink
  ) {
    const buffered = cache.since(sessionId, afterEventId);
    let replay: Event[];
    if (afterEventId !== undefined && store.hasEvent(afterEventId)) {
      // Reconnect from a persisted cursor: durable events after it cover COMPLETED rounds the client
      // missed while disconnected, while `buffered` holds only the in-flight (un-persisted) round.
      // Using `buffered` alone would drop every finished round between the cursor and the active one.
      // Merge, de-duped by id (the two sets are normally disjoint — tokens are never persisted).
      const durable = store.listEvents(sessionId, afterEventId);
      const seen = new Set(durable.map((e) => e.id));
      replay = [...durable, ...buffered.filter((e) => !seen.has(e.id))];
    } else {
      // Fresh subscribe, or a cursor that is an un-persisted live event (client resuming within the
      // active round): `buffered` is the correct tail; fall back to durable only when idle. Passing
      // an un-persisted cursor to listEvents would replay the whole session (missing-cursor fallback).
      replay = buffered.length > 0 ? buffered : store.listEvents(sessionId, afterEventId);
    }
    for (const event of replay) sink(event);
    const dispose = bus.subscribe(sessionId, sink);
    return { subscribed: true as const, dispose };
  }

  async function subscribeUi(
    { sessionId, afterEventId }: { sessionId: SessionId; afterEventId?: string },
    sink: (event: SessionUiEvent) => void
  ) {
    const session = requireSession(sessionId);
    const hydrateProjector = () => {
      const next = new SessionUiProjector({ channelStructured: isChannelStructuredSession(session) });
      const recent = store.listMessages(sessionId, {
        includeInactive: false,
        latest: true,
        limit: LIVE_SNAPSHOT_LIMIT
      });
      const oldestTs = recent[0]?.createdAt;
      next.hydrateMessages(recent, parseDurableSummary(store.getMemory(sessionId, 'ctx:summary')));
      next.hydrateExternalAgentSessions(
        store
          .listExternalAgentSessionsForTranscriptTarget(sessionId)
          .filter(
            (s) =>
              s.runtimeRole === 'managed-project-agent' ||
              s.state === 'running' ||
              s.state === 'starting' ||
              oldestTs === undefined ||
              s.startedAt >= oldestTs
          )
      );
      return { projector: next, hasMore: recent.length === LIVE_SNAPSHOT_LIMIT };
    };
    let { projector, hasMore } = hydrateProjector();
    // Replay only the in-flight (un-persisted) round on top of the hydrated window. This is a
    // snapshot endpoint (the client replaces its view wholesale), so hydration IS the reconnect
    // baseline — every settled round is already in the bounded message window. We must NOT replay
    // the durable event log here: a reconnect cursor is usually an `agent.token` id that isn't in
    // the log, so listEvents would fall back to a full-session replay and scramble the bounded
    // snapshot (breaking oldestCursor/hasMore pagination). The active round lives only in `buffered`.
    const buffered = cache.since(sessionId, afterEventId);
    for (const event of buffered) projector.applyEvent(event);
    sink(projector.snapshot({ hasMore }));
    const dispose = bus.subscribe(sessionId, (event) => {
      const resetsTranscript =
        event.type === 'session.restored' || (event.type === 'session.updated' && event.payload.reset === true);
      if (resetsTranscript) {
        ({ projector, hasMore } = hydrateProjector());
        projector.applyEvent(event);
        sink(projector.snapshot({ hasMore, replacesTranscript: true }));
        return;
      }
      for (const uiEvent of projector.applyEvent(event)) sink(uiEvent);
    });
    return { subscribed: true as const, dispose };
  }

  /**
   * Subscribe to the cross-session control stream (session-list-level changes
   * across all sessions). No replay: a (re)connecting client should re-fetch the
   * list via `sessions.list`, then apply live deltas from here.
   */
  function subscribeControl(sink: EventSink) {
    const dispose = bus.subscribeControl(sink);
    return { subscribed: true as const, dispose };
  }

  return { subscribe, subscribeUi, subscribeControl };
}
