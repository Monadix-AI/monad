import type {
  Event,
  MessageGenerationEvent,
  MessageGenerationFrame,
  MessageGenerationSubscribeRequest,
  SessionId,
  SessionUiEvent
} from '@monad/protocol';
import type { EventSink, SessionContext } from '#/handlers/session/context.ts';

import { messageGenerationEventSchema, parseEventPayload } from '@monad/protocol';

import { parseDurableSummary } from '#/agent/history.ts';
import { HandlerError } from '#/handlers/handler-error.ts';
import { isChannelStructuredSession } from '#/handlers/session/handlers/messaging-members.ts';
import { SessionUiProjector } from '#/handlers/session/ui-projection.ts';
import { EventCursorError, type ReplayScope, resolveReplayCursor } from '#/services/event-cursor.ts';

const MESSAGE_GENERATION_BUFFER_LIMIT = 256;
const MESSAGE_GENERATION_MESSAGE_LIMIT = 256;

function generationMessageId(event: MessageGenerationEvent): string | undefined {
  if (event.type === 'session.message.delta.appended') {
    return parseEventPayload(event.type, event.payload).messageId;
  }
  if (event.type !== 'session.message.completed' && event.type !== 'session.message.failed') return undefined;
  return parseEventPayload(event.type, event.payload).message.id;
}

function isTerminalGenerationEvent(event: MessageGenerationEvent): boolean {
  return event.type === 'session.message.completed' || event.type === 'session.message.failed';
}

class MessageGenerationHub {
  private readonly entries = new Map<
    string,
    { events: MessageGenerationEvent[]; sinks: Set<(event: MessageGenerationEvent) => void> }
  >();

  constructor(bus: SessionContext['deps']['bus']) {
    bus.subscribeAll((event) => {
      if (
        event.type !== 'session.message.delta.appended' &&
        event.type !== 'session.message.completed' &&
        event.type !== 'session.message.failed'
      )
        return;
      const generationEvent = messageGenerationEventSchema.parse(event);
      const messageId = generationMessageId(generationEvent);
      if (!messageId) return;
      const key = this.key(event.sessionId, messageId);
      const entry = this.touch(key);
      entry.events.push(generationEvent);
      if (entry.events.length > MESSAGE_GENERATION_BUFFER_LIMIT) {
        entry.events.splice(0, entry.events.length - MESSAGE_GENERATION_BUFFER_LIMIT);
      }
      for (const sink of [...entry.sinks]) sink(generationEvent);
      if (isTerminalGenerationEvent(generationEvent)) entry.sinks.clear();
    });
  }

  history(sessionId: string, messageId: string): MessageGenerationEvent[] {
    return [...(this.entries.get(this.key(sessionId, messageId))?.events ?? [])];
  }

  subscribe(sessionId: string, messageId: string, sink: (event: MessageGenerationEvent) => void): () => void {
    const entry = this.touch(this.key(sessionId, messageId));
    entry.sinks.add(sink);
    return () => entry.sinks.delete(sink);
  }

  private key(sessionId: string, messageId: string): string {
    return `${sessionId}:${messageId}`;
  }

  private touch(key: string) {
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing;
    }
    const created = {
      events: [] as MessageGenerationEvent[],
      sinks: new Set<(event: MessageGenerationEvent) => void>()
    };
    this.entries.set(key, created);
    if (this.entries.size > MESSAGE_GENERATION_MESSAGE_LIMIT) {
      for (const [candidate, entry] of this.entries) {
        if (this.entries.size <= MESSAGE_GENERATION_MESSAGE_LIMIT) break;
        if (entry.sinks.size === 0) this.entries.delete(candidate);
      }
    }
    return created;
  }
}

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
  const generationHub = new MessageGenerationHub(bus);

  // Resolve a resume cursor (a bare event id or an encoded `cur_` scope-bound token) to its durable/live
  // anchor for `plane`. On `session.events`, an encoded `cur_` token carries authoritative scope
  // semantics: if its anchor is gone (CURSOR_EXPIRED) the client is told 410, not silently downgraded —
  // durable replay truly cannot reconstruct the skipped state. Only a legacy bare `evt_` cursor (older
  // Last-Event-ID clients that predate the token) degrades to a fresh replay/hydration when its anchor
  // is gone. On `session.ui`, an expired anchor of EITHER cursor form always degrades to undefined
  // instead of rejecting: subscribeUi rebuilds a fresh authoritative snapshot from durable message
  // history on every connect regardless of cursor validity (docs/internals/infra/realtime-channels.md's
  // replacement-snapshot guarantee, matching message-generation and mesh-state), so there is never a
  // real "gone" state to report on this plane — only a stale resume point. Malformed (CURSOR_INVALID)
  // and cross-scope (CURSOR_WRONG_SCOPE) cursors are always rejected on every plane.
  function resolveCursorAnchor(
    plane: ReplayScope['plane'],
    sessionId: SessionId,
    cursor: string | undefined
  ): string | undefined {
    if (cursor === undefined) return undefined;
    try {
      return resolveReplayCursor(cursor, { plane, transcriptTargetId: sessionId }, { store, cache }).anchorEventId;
    } catch (error) {
      if (!(error instanceof EventCursorError) || error.code !== 'CURSOR_EXPIRED') throw error;
      const isLegacyBareCursor = !cursor.startsWith('cur_');
      if (plane === 'session.ui' || isLegacyBareCursor) return undefined;
      throw error;
    }
  }

  async function subscribe(
    { sessionId, afterEventId }: { sessionId: SessionId; afterEventId?: string },
    sink: EventSink
  ) {
    const anchor = resolveCursorAnchor('session.events', sessionId, afterEventId);
    const hasDurableAnchor = anchor !== undefined && store.hasEvent(sessionId, anchor);
    const buffered = hasDurableAnchor ? cache.since(sessionId) : cache.since(sessionId, anchor);
    let replay: Event[];
    if (hasDurableAnchor) {
      // Reconnect from a persisted cursor: durable events after it cover COMPLETED rounds the client
      // missed while disconnected, while `buffered` holds only the in-flight (un-persisted) round.
      // Using `buffered` alone would drop every finished round between the cursor and the active one.
      // Merge, de-duped by id (the two sets are normally disjoint — tokens are never persisted).
      const durable = store.listEvents(sessionId, anchor);
      const seen = new Set(durable.map((e) => e.id));
      replay = [...durable, ...buffered.filter((e) => !seen.has(e.id))];
    } else {
      // Fresh subscribe, or a cursor that is an un-persisted live event (client resuming within the
      // active round): `buffered` is the correct tail; fall back to durable only when idle. Passing
      // an un-persisted cursor to listEvents would replay the whole session (missing-cursor fallback).
      replay = buffered.length > 0 ? buffered : store.listEvents(sessionId, anchor);
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
      const next = new SessionUiProjector({
        channelStructured: isChannelStructuredSession(session),
        ...(ctx.deps.localeService ? { t: ctx.deps.localeService.t } : {})
      });
      const recent = store.listMessages(sessionId, {
        includeInactive: false,
        latest: true,
        limit: LIVE_SNAPSHOT_LIMIT
      });
      next.hydrateMessages(recent, parseDurableSummary(store.getMemory(sessionId, 'ctx:summary')));
      for (const event of store.listPendingInteractionEvents(sessionId)) next.applyEvent(event);
      return {
        projector: next,
        hasMore: recent.length === LIVE_SNAPSHOT_LIMIT,
        messageOutline: store.listUserMessageOutline(sessionId)
      };
    };
    let { projector, hasMore, messageOutline } = hydrateProjector();
    // Replay only the in-flight (un-persisted) round on top of the hydrated window. This is a
    // snapshot endpoint (the client replaces its view wholesale), so hydration IS the reconnect
    // baseline — every settled round is already in the bounded message window. We must NOT replay
    // the durable event log here: a reconnect cursor is usually a transient message-delta id that isn't in
    // the log, so listEvents would fall back to a full-session replay and scramble the bounded
    // snapshot (breaking oldestCursor/hasMore pagination). The active round lives only in `buffered`.
    const anchor = resolveCursorAnchor('session.ui', sessionId, afterEventId);
    const buffered = cache.since(sessionId, anchor);
    for (const event of buffered) projector.applyEvent(event);
    sink(projector.snapshot({ hasMore, messageOutline }));
    const dispose = bus.subscribe(sessionId, (event) => {
      const resetsTranscript =
        event.type === 'session.restored' || (event.type === 'session.updated' && event.payload.reset === true);
      if (resetsTranscript) {
        ({ projector, hasMore, messageOutline } = hydrateProjector());
        projector.applyEvent(event);
        sink(projector.snapshot({ hasMore, messageOutline, replacesTranscript: true }));
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

  async function subscribeMessageGeneration(
    request: MessageGenerationSubscribeRequest,
    sink: (frame: MessageGenerationFrame) => void
  ) {
    const { sessionId, messageId, afterEventId } = request;
    requireSession(sessionId);
    const initialMessage = store.getMessage(sessionId, messageId);
    if (!initialMessage) throw new HandlerError('invalid', `message not found: ${messageId}`);

    let disposed = false;
    let ready = false;
    const pending: MessageGenerationEvent[] = [];
    const emit = (frame: MessageGenerationFrame): void => {
      if (disposed) return;
      try {
        sink(frame);
      } catch {
        dispose();
      }
    };
    const onEvent = (event: MessageGenerationEvent): void => {
      if (!ready) {
        pending.push(event);
        return;
      }
      emit({ kind: 'event', event });
      if (isTerminalGenerationEvent(event)) dispose();
    };
    const unsubscribe = generationHub.subscribe(sessionId, messageId, onEvent);
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
    };

    const history = generationHub.history(sessionId, messageId);
    const cursorIndex = afterEventId === undefined ? -1 : history.findIndex((event) => event.id === afterEventId);
    if (afterEventId === undefined || cursorIndex === -1) {
      const message = store.getMessage(sessionId, messageId);
      if (!message) {
        dispose();
        throw new HandlerError('invalid', `message not found: ${messageId}`);
      }
      emit({
        kind: 'snapshot',
        message,
        messageRevision: store.getMessageRevision(sessionId),
        deltas: history.filter((event) => event.type === 'session.message.delta.appended')
      });
    } else {
      for (const event of history.slice(cursorIndex + 1)) {
        emit({ kind: 'event', event });
        if (isTerminalGenerationEvent(event)) dispose();
      }
    }

    ready = true;
    const replayed = new Set(history.map((event) => event.id));
    for (const event of pending) {
      if (replayed.has(event.id)) continue;
      emit({ kind: 'event', event });
      if (isTerminalGenerationEvent(event)) dispose();
    }
    if (initialMessage.stream.status === 'complete' || initialMessage.stream.status === 'error') dispose();
    return { subscribed: true as const, dispose };
  }

  // Resolve and scope-check a resume cursor without opening a subscription. The SSE events transport
  // calls this before constructing its byte-bounded stream so a bad cursor rejects with the mapped HTTP
  // status (410/409/400) instead of tearing open a 200 — the actual replay then streams lazily under
  // backpressure inside the stream's start().
  function resolveReplayAnchor(plane: ReplayScope['plane'], sessionId: SessionId, cursor: string | undefined): void {
    resolveCursorAnchor(plane, sessionId, cursor);
  }

  return { subscribe, subscribeUi, subscribeControl, subscribeMessageGeneration, resolveReplayAnchor };
}
