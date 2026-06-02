import type {
  Event,
  EventId,
  MeshAgentLoginRequirement,
  MeshAgentPendingApproval,
  MeshAgentStateEvent,
  MeshAgentStateFrame,
  MeshAgentStateLifecycleEvent,
  MeshAgentStateSession,
  SessionId
} from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';

import {
  isMeshAgentStateEvent,
  MESH_SNAPSHOT_LIFECYCLE_EVENTS_MAX,
  meshAgentStateFrameSchema,
  meshAgentStateSessionSchema,
  meshSessionIdSchema,
  meshStateFrameWithinBudget,
  parseEventPayload
} from '@monad/protocol';

const MESH_STATE_UNAVAILABLE: MeshAgentStateFrame = { kind: 'unavailable', reason: 'mesh-agent-service-unavailable' };

// Durable replay page size: at most this many events are read and held at once during a resume, so a
// long history streams out page-by-page instead of materialising the whole tail into memory.
const MESH_STATE_REPLAY_PAGE = 256;

// Live events published while the bootstrap is still paging are buffered until the baseline is emitted.
// The buffer is bounded: past this many the consumer is dropped rather than allowed to grow the daemon's
// memory (events are durable, so it reconnects and resumes from its cursor).
const MESH_STATE_LIVE_PENDING_MAX = 512;

// Build the snapshot defensively: a bounded field that somehow exceeds its canonical limit makes the
// schema parse throw or the frame exceed the byte budget; in either case degrade to `unavailable`
// rather than emit an invalid or oversized frame.
function safeSnapshot(build: () => MeshAgentStateFrame): MeshAgentStateFrame {
  try {
    const snapshot = build();
    if (meshAgentStateFrameSchema.safeParse(snapshot).success && meshStateFrameWithinBudget(snapshot)) return snapshot;
  } catch {
    // fall through to unavailable
  }
  return MESH_STATE_UNAVAILABLE;
}

import { EventCursorError } from '#/services/event-cursor.ts';

type AnchorResolution = 'known' | 'missing' | 'other_scope';

export function createMeshStateSubscribeHandler(ctx: SessionContext) {
  const {
    deps: { bus, cache, store },
    requireSession
  } = ctx;

  const snapshotCursor = (sessionId: SessionId): EventId | undefined =>
    (cache.latestEventId(sessionId) ?? store.latestEventId(sessionId)) as EventId | undefined;

  function snapshotSessions(sessionId: SessionId): MeshAgentStateSession[] {
    const views = ctx.deps.meshAgentHost?.list(sessionId).sessions ?? [];
    // Strip the presentation-only productIcon; the experience derives its own icon. The strict schema
    // rejects any other host field the daemon must not leak.
    return views.map(({ productIcon: _productIcon, ...neutral }) => meshAgentStateSessionSchema.parse(neutral));
  }

  function snapshotLoginRequirements(sessionId: SessionId): MeshAgentLoginRequirement[] {
    return ctx.deps.meshAgentHost?.pendingLoginRequirements(sessionId) ?? [];
  }

  function snapshotApprovals(sessionId: SessionId): MeshAgentPendingApproval[] {
    return store
      .listPendingInteractionEvents(sessionId)
      .filter((event) => event.type === 'mesh.approval_requested')
      .map((event) => {
        const payload = parseEventPayload('mesh.approval_requested', event.payload);
        return {
          requestId: payload.requestId,
          meshSessionId: meshSessionIdSchema.parse(payload.meshSessionId),
          provider: payload.provider,
          text: payload.text,
          ...(payload.data === undefined ? {} : { data: payload.data }),
          requestedAt: event.at
        };
      });
  }

  function snapshotLifecycleEvents(sessionId: SessionId): MeshAgentStateLifecycleEvent[] {
    return store.listRecentEventsOfTypes(
      sessionId,
      ['mesh.idle_suspended', 'mesh.idle_resumed'],
      MESH_SNAPSHOT_LIFECYCLE_EVENTS_MAX
    ) as MeshAgentStateLifecycleEvent[];
  }

  function buildSnapshot(sessionId: SessionId): MeshAgentStateFrame {
    const cursor = snapshotCursor(sessionId);
    const lifecycleEvents = snapshotLifecycleEvents(sessionId);
    return {
      kind: 'snapshot',
      ...(cursor === undefined ? {} : { cursor }),
      sessions: snapshotSessions(sessionId),
      loginRequirements: snapshotLoginRequirements(sessionId),
      approvals: snapshotApprovals(sessionId),
      ...(lifecycleEvents.length > 0 ? { lifecycleEvents } : {})
    };
  }

  function resolveAnchor(sessionId: SessionId, anchor: EventId): AnchorResolution {
    const live = cache.anchorStatus(sessionId, anchor);
    if (live === 'live') return 'known';
    if (live === 'other_scope') return 'other_scope';
    const durable = store.eventAnchorStatus(sessionId, anchor);
    if (durable === 'durable') return 'known';
    if (durable === 'other_scope') return 'other_scope';
    return 'missing';
  }

  // Resolve + scope-check a resume anchor WITHOUT opening a subscription. The SSE transport calls this
  // before constructing its byte-bounded stream so a wrong-scope anchor rejects with the mapped HTTP
  // status (409) instead of tearing open a 200 — the snapshot + durable replay then stream lazily under
  // the bounded sink inside the stream's start(), never buffered wholesale ahead of a consumer.
  function resolveMeshStateAnchor(sessionId: SessionId, afterEventId?: EventId): void {
    requireSession(sessionId);
    if (afterEventId !== undefined && resolveAnchor(sessionId, afterEventId) === 'other_scope') {
      throw new EventCursorError('wrong_scope');
    }
  }

  // Bootstrap is a CONSUMER-DEMAND state machine, not a loop that runs ahead of the reader. The
  // transport drives `pump()` from the stream's `pull()`, and each call does exactly ONE bounded unit of
  // work: the snapshot, one durable replay page, the in-flight cache tail, or the buffered-live flush.
  // Only a single page is ever resident, and `desiredSize` is never treated as awaitable backpressure.
  type BootstrapPhase = 'snapshot' | 'replay' | 'cache-tail' | 'flush' | 'live';
  type BootstrapPumpResult = 'more' | 'live' | 'overflow';

  function subscribeMeshState(
    { sessionId, afterEventId }: { sessionId: SessionId; afterEventId?: EventId },
    sink: (frame: MeshAgentStateFrame) => void
  ) {
    requireSession(sessionId);
    if (!ctx.deps.meshAgentHost) {
      sink(MESH_STATE_UNAVAILABLE);
      return { subscribed: true as const, dispose: () => {}, pump: (): BootstrapPumpResult => 'live' };
    }

    const pending: MeshAgentStateEvent[] = [];
    const pendingIds = new Set<string>();
    const replayedPendingIds = new Set<string>();
    let bootstrapping = true;
    let overflowed = false;
    let dispose: () => void = () => {};
    let phase: BootstrapPhase = 'snapshot';
    let replayCursor: string | undefined;
    let cacheTailAnchor: EventId | undefined;
    let cacheReplayCursor: EventId | undefined;
    let flushFrom = 0;

    const emitEvent = (event: MeshAgentStateEvent): void => sink({ kind: 'event', event });
    const forward = (event: Event): void => {
      if (!isMeshAgentStateEvent(event)) return;
      if (bootstrapping) {
        if (pendingIds.has(event.id)) return;
        // A consumer that cannot keep up with a long replay while the session stays busy is cut loose
        // rather than allowed to grow this buffer without bound; it reconnects and resumes from its
        // cursor with no loss.
        if (pending.length >= MESH_STATE_LIVE_PENDING_MAX) {
          overflowed = true;
          dispose();
          return;
        }
        pending.push(event);
        pendingIds.add(event.id);
        return;
      }
      // A throwing live sink (e.g. a torn SSE consumer) must release the subscription; swallow after
      // dispose so a single dead consumer can't break event delivery to the bus's other subscribers.
      try {
        emitEvent(event);
      } catch {
        dispose();
      }
    };
    // Subscribe before capturing the baseline so an event published during snapshot/replay is buffered,
    // never dropped; it is flushed (deduped) after the authoritative baseline in acceptance order.
    dispose = bus.subscribe(sessionId, forward);
    if (overflowed) dispose();
    try {
      const resolution = afterEventId === undefined ? 'missing' : resolveAnchor(sessionId, afterEventId);
      if (resolution === 'other_scope') throw new EventCursorError('wrong_scope');
      if (resolution === 'known' && afterEventId !== undefined) {
        // Exclusive replay after a known anchor has no snapshot baseline, so every buffered event is a
        // live delta the client still needs — `flushFrom` stays 0 so all of `pending` is flushed after.
        if (store.hasEvent(sessionId, afterEventId)) {
          phase = 'replay';
          replayCursor = afterEventId;
        } else {
          phase = 'cache-tail';
          cacheTailAnchor = afterEventId;
        }
      }
    } catch (error) {
      dispose();
      throw error;
    }

    const clearBootstrapState = (): void => {
      pending.length = 0;
      pendingIds.clear();
      replayedPendingIds.clear();
    };

    const settleLive = (): BootstrapPumpResult => {
      phase = 'live';
      bootstrapping = false;
      clearBootstrapState();
      return 'live';
    };

    const settleOverflow = (): BootstrapPumpResult => {
      phase = 'live';
      bootstrapping = false;
      clearBootstrapState();
      return 'overflow';
    };

    /** One bounded unit of bootstrap work per consumer demand. */
    const pump = (): BootstrapPumpResult => {
      if (overflowed) return settleOverflow();
      switch (phase) {
        case 'snapshot': {
          // The snapshot's cursor already covers every event buffered before it was captured, so those
          // must NOT be re-sent (re-sending one double-applies it on fold, or skips it on reconnect).
          // Only events buffered AFTER the baseline are unaccounted-for deltas.
          flushFrom = pending.length;
          sink(safeSnapshot(() => buildSnapshot(sessionId)));
          phase = 'flush';
          return overflowed ? settleOverflow() : 'more';
        }
        case 'replay': {
          const page =
            replayCursor === undefined ? [] : store.listEvents(sessionId, replayCursor, MESH_STATE_REPLAY_PAGE);
          for (const event of page) {
            if (!isMeshAgentStateEvent(event)) continue;
            if (pendingIds.has(event.id)) replayedPendingIds.add(event.id);
            emitEvent(event);
            if (overflowed) return settleOverflow();
          }
          const last = page[page.length - 1];
          if (page.length < MESH_STATE_REPLAY_PAGE || !last) phase = 'cache-tail';
          else replayCursor = last.id;
          return 'more';
        }
        case 'cache-tail': {
          // Page the in-flight round too: RoundCache itself can hold a long token/event stream, so
          // cloning its whole tail here would recreate the durable-replay heap spike.
          const page = cache.since(sessionId, cacheReplayCursor ?? cacheTailAnchor, MESH_STATE_REPLAY_PAGE);
          for (const event of page) {
            if (!isMeshAgentStateEvent(event)) continue;
            if (replayedPendingIds.has(event.id)) continue;
            if (pendingIds.has(event.id)) replayedPendingIds.add(event.id);
            emitEvent(event);
            if (overflowed) return settleOverflow();
          }
          const last = page[page.length - 1];
          if (page.length < MESH_STATE_REPLAY_PAGE || !last) phase = 'flush';
          else cacheReplayCursor = last.id;
          return 'more';
        }
        case 'flush': {
          while (flushFrom < pending.length) {
            const event = pending[flushFrom++];
            if (!event || replayedPendingIds.has(event.id)) continue;
            emitEvent(event);
            if (overflowed) return settleOverflow();
          }
          return settleLive();
        }
        default:
          return 'live';
      }
    };

    return { subscribed: true as const, dispose, pump };
  }

  return { subscribeMeshState, resolveMeshStateAnchor };
}
