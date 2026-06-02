import type {
  DeveloperLogRecord,
  EventId,
  MeshAgentStateFrame,
  MessageGenerationFrame,
  MessageId,
  SendMessageAttachment,
  SessionId,
  SessionUiEvent
} from '@monad/protocol';

import { subscribeDeveloperLogRecords } from '@monad/logger';
import { developerLogRecordSchema, meshAgentStateFrameSchema, meshStateFrameWithinBudget } from '@monad/protocol';

import { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';
import {
  createBoundedSseEncoderSink,
  createBoundedSseSink,
  createByteBoundedSseStream,
  createSseResponse,
  encodeSseFrame,
  startSseHeartbeat
} from '#/transports/http/sessions/sse.ts';

export function wantsInlineSessionStream(acceptHeader: string | undefined): boolean {
  return (acceptHeader ?? '').includes('text/event-stream');
}

export async function createSessionMessageSseResponse(params: {
  handlers: ReturnType<typeof createDaemonHandlers>;
  sessionId: SessionId;
  text: string;
  attachments?: SendMessageAttachment[];
  continueFromHistory?: boolean;
  ambientContext?: string;
  replyToMessageId?: MessageId;
  signal?: AbortSignal;
  encoder: TextEncoder;
}): Promise<Response> {
  const {
    handlers,
    sessionId,
    text,
    attachments,
    continueFromHistory,
    ambientContext,
    replyToMessageId,
    signal,
    encoder
  } = params;
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: unknown) => void) | undefined;
  let readySettled = false;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const markReady = (): void => {
    if (readySettled) return;
    readySettled = true;
    resolveReady?.();
  };
  const failBeforeReady = (error: unknown): void => {
    if (readySettled) return;
    readySettled = true;
    rejectReady?.(error);
  };

  const stream = createByteBoundedSseStream({
    async start(ctrl) {
      const stopHeartbeat = startSseHeartbeat(ctrl, encoder);
      const sink = createBoundedSseSink(ctrl, encoder, () => void handlers.session.abort({ id: sessionId }));
      try {
        await handlers.session.sendInline(
          { sessionId, text, attachments, continueFromHistory, replyToMessageId },
          sink,
          {
            transport: 'http',
            ambientContext,
            onReady: markReady,
            signal
          }
        );
        markReady();
      } catch (error) {
        failBeforeReady(error);
        throw error;
      } finally {
        stopHeartbeat();
        try {
          ctrl.close();
        } catch {
          // the bounded sink may have already closed the stream after dropping a slow consumer
        }
      }
    },
    cancel() {
      void handlers.session.abort({ id: sessionId });
    }
  });

  await ready;
  return createSseResponse(stream);
}

export async function createSessionEventsSseResponse(params: {
  handlers: ReturnType<typeof createDaemonHandlers>;
  sessionId: SessionId;
  afterEventId?: string;
  encoder: TextEncoder;
}): Promise<Response> {
  const { handlers, sessionId, afterEventId, encoder } = params;
  let disposeRef: (() => void) | undefined;
  let stopHeartbeat: (() => void) | undefined;
  let cancelled = false;

  // Resolve and scope-check the resume cursor before opening the stream, so an expired/invalid/
  // wrong-scope token rejects with the mapped HTTP status (410/409/400) instead of tearing open a 200.
  // The replay itself stays inside start() so it streams lazily under backpressure once the response is
  // handed off — gating the response on the full replay would buffer it into the byte-bounded queue with
  // no consumer and truncate large histories.
  handlers.session.resolveReplayAnchor('session.events', sessionId, afterEventId);

  const stream = createByteBoundedSseStream({
    async start(ctrl) {
      stopHeartbeat = startSseHeartbeat(ctrl, encoder);
      // Resuming past the last durable event replays nothing, so the stream would open without writing
      // a byte — and fetch() withholds a streamed response until its first byte, leaving the caller
      // blocked on connect until the next real event fires. Open with a comment, as
      // /v1/interactions/events does; comment lines are ignored by every SSE parser.
      ctrl.enqueue(encoder.encode(': connected\n\n'));
      // onDrop fires only after a backlog builds, by which point subscribe() has returned and
      // disposeRef is set; releasing the subscription stops the push so the queue can't regrow.
      const sink = createBoundedSseSink(ctrl, encoder, () => {
        stopHeartbeat?.();
        disposeRef?.();
      });
      const { dispose } = await handlers.session.subscribe({ sessionId, afterEventId }, sink);
      // Guard against cancel() firing before subscribe() resolved (client disconnected during
      // event replay) — the subscription was created but cancel() missed it, so dispose now.
      if (cancelled) {
        stopHeartbeat();
        dispose();
        return;
      }
      disposeRef = dispose;
    },
    cancel() {
      cancelled = true;
      stopHeartbeat?.();
      disposeRef?.();
    }
  });

  return createSseResponse(stream);
}

export async function createSessionUiEventsSseResponse(params: {
  handlers: ReturnType<typeof createDaemonHandlers>;
  sessionId: SessionId;
  afterEventId?: string;
  encoder: TextEncoder;
}): Promise<Response> {
  const { handlers, sessionId, afterEventId, encoder } = params;
  let disposeRef: (() => void) | undefined;
  let stopHeartbeat: (() => void) | undefined;
  let cancelled = false;
  let sinkRef: ((event: SessionUiEvent) => void) | undefined;
  const pending: SessionUiEvent[] = [];

  const forward = (event: SessionUiEvent): void => {
    if (cancelled) return;
    if (sinkRef) {
      sinkRef(event);
      return;
    }
    pending.push(event);
  };

  const { dispose } = await handlers.session.subscribeUi({ sessionId, afterEventId }, forward);
  if (cancelled) dispose();
  else disposeRef = dispose;

  const stream = createByteBoundedSseStream({
    async start(ctrl) {
      if (cancelled) {
        try {
          ctrl.close();
        } catch {}
        return;
      }
      stopHeartbeat = startSseHeartbeat(ctrl, encoder);
      sinkRef = createBoundedSseEncoderSink<SessionUiEvent>(
        ctrl,
        (event) => encodeSseFrame({ id: event.cursor, event: event.kind, data: event }, encoder),
        () => {
          stopHeartbeat?.();
          disposeRef?.();
        }
      );
      for (const event of pending.splice(0)) sinkRef(event);
    },
    cancel() {
      cancelled = true;
      stopHeartbeat?.();
      sinkRef = undefined;
      disposeRef?.();
      disposeRef = undefined;
    }
  });

  return createSseResponse(stream);
}

const meshStateFrameId = (frame: MeshAgentStateFrame): EventId | undefined =>
  frame.kind === 'snapshot' ? frame.cursor : frame.kind === 'event' ? frame.event.id : undefined;

export async function createSessionMeshStateSseResponse(params: {
  handlers: ReturnType<typeof createDaemonHandlers>;
  sessionId: SessionId;
  afterEventId?: EventId;
  encoder: TextEncoder;
}): Promise<Response> {
  const { handlers, sessionId, afterEventId, encoder } = params;
  let disposeRef: (() => void) | undefined;
  let stopHeartbeat: (() => void) | undefined;
  let pumpRef: (() => 'more' | 'live' | 'overflow') | undefined;
  let cancelled = false;

  // Resolve + scope-check the resume anchor before opening the stream, so a wrong-scope token rejects
  // with the mapped HTTP status (409) instead of tearing open a 200. The snapshot + durable replay then
  // stream lazily under the byte-bounded sink inside start() — gating the response on the full replay
  // would buffer every frame with no consumer and blow heap on a large history.
  handlers.session.resolveMeshStateAnchor(sessionId, afterEventId);

  const stream = createByteBoundedSseStream({
    async start(ctrl) {
      stopHeartbeat = startSseHeartbeat(ctrl, encoder);
      const sink = createBoundedSseEncoderSink<MeshAgentStateFrame>(
        ctrl,
        (frame) => {
          // Final encode-boundary guard for EVERY frame kind: a frame that fails validation or exceeds
          // the byte budget (a live event with an unbounded payload, an oversized snapshot) is replaced
          // with `unavailable` before its bytes are ever allocated into the queue.
          const safe: MeshAgentStateFrame =
            meshAgentStateFrameSchema.safeParse(frame).success && meshStateFrameWithinBudget(frame)
              ? frame
              : { kind: 'unavailable', reason: 'mesh-agent-service-unavailable' };
          return encodeSseFrame(
            {
              ...(meshStateFrameId(safe) ? { id: meshStateFrameId(safe) } : {}),
              event: safe.kind,
              data: meshAgentStateFrameSchema.parse(safe)
            },
            encoder
          );
        },
        () => {
          stopHeartbeat?.();
          disposeRef?.();
        }
      );
      const { dispose, pump } = await handlers.session.subscribeMeshState(
        { sessionId, ...(afterEventId ? { afterEventId } : {}) },
        sink
      );
      // cancel() can fire before subscribe() resolves (client disconnected during replay) — the
      // subscription exists but cancel() missed it, so dispose now.
      if (cancelled) {
        stopHeartbeat();
        dispose();
        return;
      }
      disposeRef = dispose;
      pumpRef = pump;
    },
    // Consumer demand drives the bootstrap: each pull advances it by exactly one bounded unit (the
    // snapshot, one durable replay page, the cache tail, or the buffered-live flush), so a long replay
    // never runs ahead of the reader and only one page is resident at a time.
    pull(ctrl) {
      if (cancelled) return;
      if (pumpRef?.() !== 'overflow') return;
      cancelled = true;
      stopHeartbeat?.();
      disposeRef?.();
      disposeRef = undefined;
      try {
        ctrl.close();
      } catch {}
    },
    cancel() {
      cancelled = true;
      stopHeartbeat?.();
      disposeRef?.();
    }
  });

  return createSseResponse(stream);
}

export async function createSessionMessageGenerationSseResponse(params: {
  handlers: ReturnType<typeof createDaemonHandlers>;
  sessionId: SessionId;
  messageId: MessageId;
  afterEventId?: EventId;
  encoder: TextEncoder;
}): Promise<Response> {
  const { handlers, sessionId, messageId, afterEventId, encoder } = params;
  let disposeRef: (() => void) | undefined;
  let stopHeartbeat: (() => void) | undefined;
  let sinkRef: ((frame: MessageGenerationFrame) => void) | undefined;
  let cancelled = false;
  const pending: MessageGenerationFrame[] = [];
  const terminal = (frame: MessageGenerationFrame): boolean =>
    frame.kind === 'snapshot'
      ? frame.message.stream.status === 'complete' || frame.message.stream.status === 'error'
      : frame.event.type === 'session.message.completed' || frame.event.type === 'session.message.failed';
  const forward = (frame: MessageGenerationFrame): void => {
    if (cancelled) return;
    if (!sinkRef) {
      pending.push(frame);
      return;
    }
    sinkRef(frame);
    if (terminal(frame)) {
      stopHeartbeat?.();
      disposeRef?.();
      disposeRef = undefined;
    }
  };
  const { dispose } = await handlers.session.subscribeMessageGeneration(
    { sessionId, messageId, afterEventId },
    forward
  );
  if (cancelled) dispose();
  else disposeRef = dispose;

  const stream = createByteBoundedSseStream({
    start(ctrl) {
      stopHeartbeat = startSseHeartbeat(ctrl, encoder);
      const close = (): void => {
        stopHeartbeat?.();
        try {
          ctrl.close();
        } catch {}
      };
      sinkRef = createBoundedSseEncoderSink<MessageGenerationFrame>(
        ctrl,
        (frame) => {
          if (frame.kind === 'snapshot') {
            return encodeSseFrame({ event: 'session.message.snapshot', data: frame }, encoder);
          }
          return encodeSseFrame({ id: frame.event.id, event: frame.event.type, data: frame }, encoder);
        },
        () => {
          stopHeartbeat?.();
          disposeRef?.();
          disposeRef = undefined;
        }
      );
      for (const frame of pending.splice(0)) {
        sinkRef(frame);
        if (terminal(frame)) {
          disposeRef?.();
          disposeRef = undefined;
          close();
          return;
        }
      }
      const originalSink = sinkRef;
      sinkRef = (frame) => {
        originalSink(frame);
        if (terminal(frame)) close();
      };
    },
    cancel() {
      cancelled = true;
      stopHeartbeat?.();
      sinkRef = undefined;
      disposeRef?.();
      disposeRef = undefined;
    }
  });
  return createSseResponse(stream);
}

export function createSessionLogsSseResponse(params: { sessionId: SessionId; encoder: TextEncoder }): Response {
  const { sessionId, encoder } = params;
  let disposeRef: (() => void) | undefined;
  let stopHeartbeat: (() => void) | undefined;

  const stream = createByteBoundedSseStream({
    start(ctrl) {
      ctrl.enqueue(encoder.encode(': connected\n\n'));
      stopHeartbeat = startSseHeartbeat(ctrl, encoder);
      const sink = createBoundedSseEncoderSink<DeveloperLogRecord>(
        ctrl,
        (record) => encodeSseFrame({ event: 'log', data: record }, encoder),
        () => {
          stopHeartbeat?.();
          disposeRef?.();
        }
      );
      disposeRef = subscribeDeveloperLogRecords((record) => {
        if (record.sessionId !== sessionId || typeof record.level !== 'number') return;
        // Validate at the wire boundary instead of casting (records are already redacted upstream).
        const parsed = developerLogRecordSchema.safeParse(record);
        if (parsed.success) sink(parsed.data);
      });
    },
    cancel() {
      stopHeartbeat?.();
      disposeRef?.();
      disposeRef = undefined;
    }
  });

  return createSseResponse(stream);
}
